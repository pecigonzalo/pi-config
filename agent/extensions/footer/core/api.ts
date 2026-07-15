import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FOOTER_ACTIVATE_LAYOUT_EVENT,
	FOOTER_INVALIDATE_EVENT,
	FOOTER_REGISTER_EVENT,
	FOOTER_UNREGISTER_EVENT,
	type FooterActivateLayoutEventPayload,
	type FooterInvalidateEventPayload,
	type FooterItem,
	type FooterRegisterEventPayload,
	type FooterUnregisterEventPayload,
} from "./types";

export function registerFooterItem(pi: ExtensionAPI, item: FooterItem): void {
	const payload: FooterRegisterEventPayload = { item };
	pi.events.emit(FOOTER_REGISTER_EVENT, payload);
}

export function unregisterFooterItem(pi: ExtensionAPI, owner: string, id?: string): void {
	const payload: FooterUnregisterEventPayload = { owner, id };
	pi.events.emit(FOOTER_UNREGISTER_EVENT, payload);
}

export function invalidateFooterItem(pi: ExtensionAPI, owner?: string, id?: string): void {
	const payload: FooterInvalidateEventPayload = { owner, id };
	pi.events.emit(FOOTER_INVALIDATE_EVENT, payload);
}

export function activateFooterLayout(
	pi: ExtensionAPI,
	layoutName: FooterActivateLayoutEventPayload["layoutName"],
): void {
	const payload: FooterActivateLayoutEventPayload = { layoutName };
	pi.events.emit(FOOTER_ACTIVATE_LAYOUT_EVENT, payload);
}
