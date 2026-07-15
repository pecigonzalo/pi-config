import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invalidateFooterItem, registerFooterItem, unregisterFooterItem } from "../core/api";

const owner = "footer-custom-row-example";
const itemId = "turn-counter";

export default function customRowExample(pi: ExtensionAPI) {
	let turnCount = 0;

	pi.on("session_start", async () => {
		turnCount = 0;

		registerFooterItem(pi, {
			owner,
			id: itemId,
			getPlacement() {
				return { row: "extra", section: "x", order: 10 };
			},
			render: ({ theme }) => theme.fg("accent", `turns:${turnCount}`),
			onTurnEnd() {
				turnCount += 1;
				invalidateFooterItem(pi, owner, itemId);
			},
		});
	});

	pi.on("session_shutdown", async () => {
		unregisterFooterItem(pi, owner, itemId);
	});
}
