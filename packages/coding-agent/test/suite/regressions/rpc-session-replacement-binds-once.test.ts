import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression: an RPC session replacement bound the extensions twice, so every extension got
// session_start twice and the built-in MCP started its servers twice.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Like AgentSessionRuntime, every replacement ends by calling the rebind callback the mode registered.
function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	let rebind: ((session: AgentSession) => Promise<void>) | undefined;
	const replace = async () => {
		await rebind?.(session);
		return { cancelled: false };
	};
	return {
		session,
		newSession: vi.fn(replace),
		switchSession: vi.fn(replace),
		fork: vi.fn(async () => ({ ...(await replace()), selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback?: (session: AgentSession) => Promise<void>) => {
			rebind = callback;
		}),
	} as unknown as AgentSessionRuntime;
}

describe("RPC session replacement binds extensions once", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test.each([
		{ type: "new_session" },
		{ type: "switch_session", sessionPath: "/tmp/other-session.jsonl" },
		{ type: "fork", entryId: "entry" },
	])("$type binds the extensions once", async (command) => {
		const listenerSnapshot = takeListenerSnapshot();
		harness = await createHarness();
		const bindExtensions = vi.spyOn(harness.session, "bindExtensions");

		try {
			void runRpcMode(createRuntimeHost(harness.session));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const bindsAtStart = bindExtensions.mock.calls.length;

			rpcIo.lineHandler?.(JSON.stringify({ id: "replace", ...command }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual(
					expect.objectContaining({ id: "replace", type: "response", command: command.type, success: true }),
				);
			});
			expect(bindExtensions.mock.calls.length - bindsAtStart).toBe(1);
		} finally {
			restoreListeners(listenerSnapshot);
		}
	});
});
