import type { FooterItem, FooterLayoutName, FooterPlacement } from "../core/types";
import type { FooterConfigController } from "../config";
import type { StarshipController } from "../starship";

const owner = "footer";

const defaultPlacements: Record<FooterLayoutName, FooterPlacement> = {
	default: { row: "context", section: "a", order: 5, priority: 100 },
	minimal: { row: "context", section: "a", order: 5, priority: 100 },
	compact: { row: "context", section: "a", order: 5, priority: 100 },
	full: { row: "context", section: "a", order: 5, priority: 100 },
};

export function createStarshipItems(starship: StarshipController, config: FooterConfigController): FooterItem[] {
	return [
		{
			owner,
			id: "starship-lifecycle",
			getPlacement: () => undefined,
			render: () => null,
			onSessionStart: () => starship.onSessionStart(),
			onTurnEnd: () => starship.onTurnEnd(),
			onToolResult: (event) => starship.onToolResult(event),
			onSessionShutdown: () => starship.onSessionShutdown(),
		},
		{
			owner,
			id: "starship",
			getPlacement: (layoutName) =>
				config.resolvePlacement("starship", layoutName, defaultPlacements[layoutName]),
			render: ({ ctx, width, layoutName }) => starship.renderPrompt(ctx, width, layoutName),
		},
	];
}
