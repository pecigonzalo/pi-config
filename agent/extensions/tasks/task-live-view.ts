import {
	AssistantMessageComponent,
	ExtensionInputComponent,
	ToolExecutionComponent,
	type AgentSessionEvent,
	type ExtensionContext,
	type ExtensionUIContext,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { LiveTaskController } from "./task-live.js";

/**
 * The /tasks attach live view: a real component (built from the same message/tool-execution
 * rendering pieces interactive mode itself uses) subscribed directly to a running worker's
 * AgentSession -- no polling, no wire protocol. Typing a line and pressing Enter calls
 * controller.session.steer(text) directly; Escape detaches without touching the worker.
 */

/**
 * Derived (rather than imported from "@earendil-works/pi-tui" directly) because this workspace
 * package's own pi-tui peer dependency can resolve to a different on-disk copy than the one
 * pi-coding-agent's own components are built against -- deriving it from ExtensionUIContext's
 * own custom() signature guarantees the exact nominal type ToolExecutionComponent etc. expect.
 */
type CustomComponentFactory = Parameters<ExtensionUIContext["custom"]>[0];
type LiveViewTui = Parameters<CustomComponentFactory>[0];

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

class TaskLiveViewComponent extends Container implements Focusable, Component {
	private readonly chat = new Container();
	private inputRow: ExtensionInputComponent;
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private streamingComponent: AssistantMessageComponent | undefined;
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(
		private readonly controller: LiveTaskController,
		private readonly tui: LiveViewTui,
		private readonly cwd: string,
		private readonly done: (result: { detachReason: "detached" | "exited" }) => void,
	) {
		super();
		this.addChild(new Text(`Attached: ${controller.agent} (step ${controller.step}) -- Esc to detach`, 0, 0));
		this.addChild(this.chat);
		this.inputRow = this.createInputRow();
		this.addChild(this.inputRow);
		this.replayHistory();
		this.unsubscribe = controller.session.subscribe((event) => this.handleEvent(event));
	}

	private createInputRow(): ExtensionInputComponent {
		return new ExtensionInputComponent(
			"Steer",
			"Type a message and press Enter, or Esc to detach",
			(value) => this.handleSubmit(value),
			() => this.done({ detachReason: "detached" }),
			{ tui: this.tui },
		);
	}

	private handleSubmit(value: string): void {
		const text = value.trim();
		if (text) void this.controller.session.steer(text);
		this.removeChild(this.inputRow);
		this.inputRow = this.createInputRow();
		this.inputRow.focused = true;
		this.addChild(this.inputRow);
		this.tui.requestRender();
	}

	private replayHistory(): void {
		for (const message of this.controller.session.messages) {
			if (message.role === "user")
				this.chat.addChild(new UserMessageComponent(extractMessageText(message.content)));
			else if (message.role === "assistant") this.chat.addChild(new AssistantMessageComponent(message));
		}
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent();
					this.chat.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message);
				} else if (event.message.role === "user") {
					this.chat.addChild(new UserMessageComponent(extractMessageText(event.message.content)));
				}
				break;
			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message);
					for (const content of event.message.content) {
						if (content.type !== "toolCall") continue;
						const existing = this.pendingTools.get(content.id);
						if (existing) existing.updateArgs(content.arguments);
						else {
							const component = new ToolExecutionComponent(
								content.name,
								content.id,
								content.arguments,
								{},
								undefined,
								this.tui,
								this.cwd,
							);
							this.chat.addChild(component);
							this.pendingTools.set(content.id, component);
						}
					}
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.streamingComponent?.updateContent(event.message);
					this.streamingComponent = undefined;
					for (const [, component] of this.pendingTools) component.setArgsComplete();
				}
				break;
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{},
						undefined,
						this.tui,
						this.cwd,
					);
					this.chat.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update": {
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			}
			case "tool_execution_end": {
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError });
				this.pendingTools.delete(event.toolCallId);
				break;
			}
			case "agent_settled":
				if (this.controller.status !== "running") {
					this.done({ detachReason: "exited" });
					return;
				}
				break;
			default:
				break;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	get focused(): boolean {
		return this.inputRow.focused;
	}

	set focused(value: boolean) {
		this.inputRow.focused = value;
	}

	handleInput(data: string): void {
		this.inputRow.handleInput(data);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.inputRow.dispose();
	}
}

export interface AttachToLiveTaskControllerResult {
	ok: boolean;
	level: "info" | "warning" | "error";
	message: string;
}

export async function attachToLiveTaskController(
	ctx: Pick<ExtensionContext, "ui" | "hasUI">,
	controller: LiveTaskController,
): Promise<AttachToLiveTaskControllerResult> {
	if (!ctx.hasUI) {
		return { ok: false, level: "warning", message: "Attach requires an interactive terminal." };
	}
	const result = await ctx.ui.custom<{ detachReason: "detached" | "exited" }>(
		(tui, _theme, _keybindings, done) =>
			new TaskLiveViewComponent(controller, tui, controller.session.sessionManager.getCwd(), done),
		{ overlay: true },
	);
	return {
		ok: true,
		level: "info",
		message:
			result.detachReason === "exited"
				? `Task ${controller.agent} (step ${controller.step}) finished while attached.`
				: `Detached from ${controller.agent} (step ${controller.step}); it keeps running in the background.`,
	};
}
