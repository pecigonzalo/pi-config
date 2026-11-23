import type { FooterItem, FooterLayoutName, FooterPlacement } from "../core/types";
import type { FooterConfigController } from "../config";
import type { PathMode, SegmentId, SessionContextController } from "../session-context";
import type { StarshipController } from "../starship";

const owner = "footer";

const pathModes: Record<FooterLayoutName, PathMode> = {
	default: "basename",
	minimal: "basename",
	compact: "abbreviated",
	full: "abbreviated",
};

const defaultPlacements: Record<SegmentId, Partial<Record<FooterLayoutName, FooterPlacement>>> = {
	path: {
		default: { row: "context", section: "a", order: 10, priority: 100 },
		minimal: { row: "context", section: "a", order: 10, priority: 100 },
		compact: { row: "context", section: "a", order: 10, priority: 100 },
		full: { row: "context", section: "a", order: 10, priority: 100 },
	},
	git: {
		default: { row: "context", section: "b", order: 10, priority: 95 },
		minimal: { row: "context", section: "b", order: 10, priority: 95 },
		compact: { row: "context", section: "b", order: 10, priority: 95 },
		full: { row: "context", section: "b", order: 10, priority: 95 },
	},
	agent: {
		default: { row: "context", section: "c", order: 10, priority: 40 },
		compact: { row: "context", section: "c", order: 10, priority: 40 },
		full: { row: "context", section: "c", order: 10, priority: 40 },
	},
	model: {
		default: { row: "context", section: "c", order: 20, priority: 80, maxWidth: 34 },
		compact: { row: "context", section: "c", order: 20, priority: 80, maxWidth: 34 },
		full: { row: "context", section: "c", order: 20, priority: 80, maxWidth: 34 },
	},
	thinking: {
		default: { row: "context", section: "c", order: 30, priority: 30 },
		full: { row: "context", section: "c", order: 30, priority: 30 },
	},
	context: {
		default: { row: "context", section: "x", order: 10, priority: 90 },
		minimal: { row: "context", section: "z", order: 10, priority: 90 },
		compact: { row: "context", section: "y", order: 10, priority: 90 },
		full: { row: "context", section: "x", order: 10, priority: 90 },
	},
	tokens: {
		default: { row: "context", section: "y", order: 10, priority: 20 },
		full: { row: "context", section: "y", order: 10, priority: 20 },
	},
	cost: {
		default: { row: "context", section: "z", order: 10, priority: 10 },
		compact: { row: "context", section: "z", order: 10, priority: 10 },
		full: { row: "context", section: "z", order: 10, priority: 10 },
	},
	time_spent: {
		full: { row: "context", section: "z", order: 20, priority: 15 },
	},
};

function createPlacementGetter(
	config: FooterConfigController,
	segment: SegmentId,
): (layoutName: FooterLayoutName) => FooterPlacement | undefined {
	return (layoutName) => config.resolvePlacement(segment, layoutName, defaultPlacements[segment][layoutName]);
}

function shouldHideForStarship(
	segment: SegmentId,
	config: FooterConfigController,
	starship: StarshipController,
	layoutName: FooterLayoutName,
	width: number,
	ctx: Parameters<SessionContextController["renderSegment"]>[0],
): boolean {
	if (segment !== "path" && segment !== "git") return false;
	const starshipPlacement = config.resolvePlacement("starship", layoutName, {
		row: "context",
		section: "a",
		order: 5,
		priority: 100,
	});
	const isLeftSide =
		starshipPlacement?.row === "context" &&
		(starshipPlacement.section === "a" || starshipPlacement.section === "b" || starshipPlacement.section === "c");
	return Boolean(isLeftSide) && starship.hasPrompt(ctx, width, layoutName);
}

function createSegmentItem(
	segment: SegmentId,
	controller: SessionContextController,
	config: FooterConfigController,
	starship: StarshipController,
): FooterItem {
	return {
		owner,
		id: segment,
		getPlacement: createPlacementGetter(config, segment),
		render: ({ ctx, layoutName, width }) => {
			if (shouldHideForStarship(segment, config, starship, layoutName, width, ctx)) return null;
			return controller.renderSegment(
				ctx,
				segment,
				segment === "path" ? { pathMode: pathModes[layoutName] } : undefined,
			);
		},
	};
}

export function createSessionContextItems(
	controller: SessionContextController,
	config: FooterConfigController,
	starship: StarshipController,
): FooterItem[] {
	return [
		{
			owner,
			id: "session-context-lifecycle",
			getPlacement: () => undefined,
			render: () => null,
			onSessionStart: () => controller.onSessionStart(),
			onTurnStart: () => controller.onTurnStart(),
			onTurnEnd: () => controller.onTurnEnd(),
			onModelSelect: () => controller.onModelSelect(),
			onThinkingLevelSelect: () => controller.onThinkingLevelSelect(),
			onToolResult: (event) => controller.onToolResult(event),
			onSessionShutdown: () => controller.onSessionShutdown(),
		},
		createSegmentItem("path", controller, config, starship),
		createSegmentItem("git", controller, config, starship),
		createSegmentItem("agent", controller, config, starship),
		createSegmentItem("model", controller, config, starship),
		createSegmentItem("thinking", controller, config, starship),
		createSegmentItem("context", controller, config, starship),
		createSegmentItem("tokens", controller, config, starship),
		createSegmentItem("cost", controller, config, starship),
		createSegmentItem("time_spent", controller, config, starship),
	];
}
