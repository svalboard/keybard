import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRule, KeyboardInfo } from "@/types/keyboard.types";
import { appId } from "@/services/app-rules";

const state = vi.hoisted(() => ({
    keyboard: null as KeyboardInfo | null,
    connected: true,
    queue: vi.fn(async (_d: string, _cb: () => Promise<void>, _m?: unknown) => {}),
    write: vi.fn(async () => 1),
    read: vi.fn(async () => ({ rules: [], enabled: true })),
    hostApps: null as unknown,
}));

vi.mock("@/contexts/KeyboardContext", () => ({
    useKeyboard: () => ({
        keyboard: state.keyboard,
        isConnected: state.connected,
        setKeyboard: (next: KeyboardInfo | ((k: KeyboardInfo | null) => KeyboardInfo | null)) => {
            state.keyboard = typeof next === "function" ? next(state.keyboard) : next;
        },
    }),
}));
vi.mock("@/contexts/ChangesContext", () => ({ useChanges: () => ({ queue: state.queue }) }));
vi.mock("@/features/trainer/host-apps", () => ({ fetchHostApps: async () => state.hostApps }));
vi.mock("@/services/app-rules", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/app-rules")>()),
    writeAppRules: state.write,
    readAppRules: state.read,
    readAppForeground: async () => ({ appId: 0, msLeft: 0, rule: 0, frontLayer: null, onMask: 0, offMask: 0, flags: 1 }),
}));

import AppRulesSection, { APP_RULES_WRITE_DELAY_MS } from "@/layout/SecondarySidebar/Panels/AppRulesSection";

const board = (rules: AppRule[] | undefined, flags5 = 1): KeyboardInfo =>
    ({ rows: 1, cols: 1, layers: 16, feature_flags5: flags5, app_rules: rules, cosmetic: { layer: {} } } as unknown as KeyboardInfo);

const blank: AppRule = { appId: 0, defaultLayer: null, frontLayer: null, onMask: 0, offMask: 0, flags: 0, text: "", key: "" };

function renderSection(compact = false) {
    const view = render(<AppRulesSection compact={compact} />);
    const rerender = () => view.rerender(<AppRulesSection compact={compact} />);
    return { ...view, rerender };
}

describe("AppRulesSection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        state.queue.mockClear();
        state.write.mockClear();
        state.connected = true;
        state.hostApps = null;
        localStorage.clear();
    });
    afterEach(() => vi.useRealTimers());

    it("is hidden on firmware without the feature bit", () => {
        state.keyboard = board([], 0);
        const { container } = renderSection();
        expect(container.querySelector("[data-app-rules]")).toBeNull();
    });

    it("says when the rules couldn't be read", () => {
        state.keyboard = board(undefined);
        renderSection();
        expect(screen.getByRole("alert").textContent).toMatch(/couldn't read the app rules/);
    });

    it("adds a rule (empty, on, with sample placeholders), names it, and writes a burst of edits once", async () => {
        state.keyboard = board([]);
        const view = renderSection();
        expect(screen.getByTestId("app-rules-count").textContent).toBe("0 of 64 rules");
        expect(screen.getByTestId("app-rules-bytes").textContent).toBe("4 of 1792 bytes used");
        fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
        view.rerender();
        expect(state.keyboard!.app_rules![0]).toMatchObject({ appId: 0, text: "", flags: 0 });
        const input = screen.getByLabelText("Rule 1 app") as HTMLInputElement;
        expect(input.value).toBe("");
        expect(input.placeholder).toMatch(/^(program\.exe|com\.example\.app|program)$/);
        expect(screen.getByRole("group", { name: "Rule 1" }).querySelector("button[aria-pressed='true']")!.textContent).toBe("ON");
        fireEvent.change(screen.getByLabelText("Rule 1 app"), { target: { value: "Notepad.exe" } });
        view.rerender();
        const r = state.keyboard!.app_rules![0];
        expect(r).toMatchObject({ key: "Notepad.exe", appId: appId("notepad.exe"), text: "Notepad.exe" });
        expect(screen.getByTestId("app-rules-bytes").textContent).toBe(`${4 + 12 + 11} of 1792 bytes used`);
        fireEvent.change(screen.getByTestId("app-rule-default"), { target: { value: "2" } });
        view.rerender();
        fireEvent.change(screen.getByTestId("app-rule-front"), { target: { value: "5" } });
        view.rerender();
        expect(state.queue).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS); });
        expect(state.queue).toHaveBeenCalledTimes(1);
        const [desc, cb, meta] = state.queue.mock.calls[0];
        expect(desc).toBe("App rules");
        expect(meta).toMatchObject({ writeKey: "app-rules" });
        await cb();
        expect(state.write).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ defaultLayer: 2, frontLayer: 5, text: "Notepad.exe" })], true);
    });

    it("the App Layers switch writes the header and then shows what the board holds", async () => {
        state.keyboard = board([{ ...blank, key: "notepad.exe", appId: appId("notepad.exe"), text: "notepad.exe" }]);
        const view = renderSection();
        const sw = () => screen.getByRole("group", { name: "App Layers" });
        expect(sw().querySelector("button[aria-pressed='true']")!.textContent).toBe("ON");
        fireEvent.click(screen.getAllByRole("button", { name: "OFF" })[0]);
        view.rerender();
        expect(state.keyboard!.app_layers_enabled).toBe(false);
        expect(sw().querySelector("button[aria-pressed='true']")!.textContent).toBe("OFF");
        await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS); });
        const [, cb] = state.queue.mock.calls[0];
        state.read.mockResolvedValueOnce({ rules: [], enabled: false });
        await cb();
        expect(state.write).toHaveBeenCalledWith(expect.anything(), expect.any(Array), false);
        expect(state.read).toHaveBeenCalled();
        expect(state.keyboard!.app_layers_enabled).toBe(false);
    });

    it("a rule's own switch turns it off and on", () => {
        state.keyboard = board([{ ...blank, key: "notepad.exe", appId: appId("notepad.exe"), text: "notepad.exe" }]);
        const view = renderSection();
        const group = () => screen.getByRole("group", { name: "Rule 1" });
        fireEvent.click(group().querySelectorAll("button")[1]);
        view.rerender();
        expect(state.keyboard!.app_rules![0].flags & 1).toBe(1);
        expect(document.querySelector("[data-app-rule='0']")!.getAttribute("data-rule-on")).toBe("false");
        fireEvent.click(group().querySelectorAll("button")[0]);
        view.rerender();
        expect(state.keyboard!.app_rules![0].flags & 1).toBe(0);
    });

    it("refuses a name past 64 bytes, and an edit past the board's room, with one line", () => {
        state.keyboard = board([{ ...blank }]);
        const view = renderSection();
        fireEvent.change(screen.getByLabelText("Rule 1 app"), { target: { value: "x".repeat(65) } });
        view.rerender();
        expect(state.keyboard!.app_rules![0].text).toBe("");
        expect(screen.getByTestId("app-rule-notice").textContent).toBe("Names can be at most 64 bytes.");
        fireEvent.change(screen.getByLabelText("Rule 1 app"), { target: { value: "x".repeat(64) } });
        view.rerender();
        expect(state.keyboard!.app_rules![0].text).toHaveLength(64);
        expect(screen.queryByTestId("app-rule-notice")).toBeNull();
        // Fill the record: 23 rules of 64-byte names take 4 + 23 * 76 = 1752 bytes.
        const big = Array.from({ length: 23 }, (_, i) => ({ ...blank, key: `${"y".repeat(62)}${String(i).padStart(2, "0")}`, text: `${"y".repeat(62)}${String(i).padStart(2, "0")}`, appId: i + 1 }));
        state.keyboard = { ...state.keyboard!, layers: 2, app_rules: big };
        view.rerender();
        fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
        view.rerender();
        expect(state.keyboard!.app_rules).toHaveLength(24); // 1764 bytes: an empty rule fits
        fireEvent.change(screen.getByLabelText("Rule 24 app"), { target: { value: "a-name-long-enough-to-pass-the-room.exe" } });
        view.rerender();
        expect(state.keyboard!.app_rules![23].text).toBe("");
        expect(screen.getByTestId("app-rule-notice").textContent).toBe("Not enough room left on the board.");
    });

    it("pills cycle neutral, on, off and say so", () => {
        state.keyboard = board([{ ...blank }]);
        const view = renderSection();
        const pill = () => document.querySelector('[data-app-rule-pills] [data-layer="3"]') as HTMLButtonElement;
        // The mouse layer (15, the last) is Auto Mouse's: no pill, as on the Auto Mouse pills.
        expect(document.querySelectorAll("[data-app-rule-pills] [data-layer]")).toHaveLength(15);
        expect(document.querySelector('[data-app-rule-pills] [data-layer="15"]')).toBeNull();
        expect(pill().dataset.state).toBe("neutral");
        expect(pill().getAttribute("aria-label")).toMatch(/Layer 3 .*: unchanged/);
        fireEvent.click(pill());
        view.rerender();
        expect(pill().dataset.state).toBe("on");
        expect(state.keyboard!.app_rules![0].onMask).toBe(8);
        fireEvent.click(pill());
        view.rerender();
        expect(pill().dataset.state).toBe("off");
        expect(pill().querySelector("span")!.className).toMatch(/line-through/);
        expect(state.keyboard!.app_rules![0]).toMatchObject({ onMask: 0, offMask: 8 });
        fireEvent.click(pill());
        view.rerender();
        expect(pill().dataset.state).toBe("neutral");
    });

    it("each rule has a grip to reorder it, and no up or down buttons", () => {
        state.keyboard = board([{ ...blank, text: "A" }, { ...blank, text: "B" }]);
        renderSection();
        const grip = screen.getByRole("button", { name: "Reorder rule 1" });
        expect(grip.getAttribute("aria-roledescription")).toBe("sortable");
        expect(grip.getAttribute("tabindex")).toBe("0");
        expect(screen.getByRole("button", { name: "Reorder rule 2" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Move rule/ })).toBeNull();
        // The grip comes first in the rule, before its kind and the delete button.
        const li = document.querySelector("[data-app-rule='0']")!;
        expect(li.querySelector("button")).toBe(grip);
        expect(document.body.textContent).toMatch(/Press Space to pick up a rule/);
    });

    describe("keyboard reorder", () => {
        // jsdom lays nothing out: each rule is 90px tall, 100px apart, so dnd-kit can measure them.
        let spy: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
                const li = this.closest("[data-app-rule]");
                const i = li ? Number(li.getAttribute("data-app-rule")) : 0;
                const top = i * 100;
                return { x: 0, y: top, top, left: 0, right: 300, bottom: top + 90, width: 300, height: 90, toJSON: () => ({}) } as DOMRect;
            });
        });
        afterEach(() => spy.mockRestore());

        const key = async (el: Element, code: string) => {
            await act(async () => {
                fireEvent.keyDown(el, { code, key: code === "Space" ? " " : code });
                vi.advanceTimersByTime(50);
            });
        };
        const texts = () => state.keyboard!.app_rules!.map((r) => r.text);

        it("Space picks up, arrows move, Space drops: the new order is written once", async () => {
            state.keyboard = board([{ ...blank, text: "A" }, { ...blank, text: "B" }, { ...blank, text: "C" }]);
            const view = renderSection();
            const grip = screen.getByRole("button", { name: "Reorder rule 1" });
            grip.focus();
            await key(grip, "Space");
            expect(document.body.textContent).toMatch(/Rule 1 is at position 1 of 3\./);
            await key(grip, "ArrowDown");
            await key(grip, "ArrowDown");
            expect(document.body.textContent).toMatch(/Rule 1 is at position 3 of 3\./);
            // Nothing changes while the rule is moving.
            expect(texts()).toEqual(["A", "B", "C"]);
            await key(grip, "Space");
            view.rerender();
            expect(texts()).toEqual(["B", "C", "A"]);
            expect(document.body.textContent).toMatch(/Rule 1 dropped at position 3\./);
            // The numbers follow the new order.
            expect(document.querySelector("[data-app-rule='2'] [data-testid='app-rule-grip']")!.textContent).toBe("3");
            expect(screen.getByRole("button", { name: "Reorder rule 3" })).toBeTruthy();
            await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS); });
            expect(state.queue).toHaveBeenCalledTimes(1);
            await state.queue.mock.calls[0][1]();
            expect(state.write).toHaveBeenCalledTimes(1);
            expect(state.write).toHaveBeenCalledWith(expect.anything(), [
                expect.objectContaining({ text: "B" }), expect.objectContaining({ text: "C" }), expect.objectContaining({ text: "A" }),
            ], true);
        });

        it("Escape cancels: the order stays and nothing is written", async () => {
            state.keyboard = board([{ ...blank, text: "A" }, { ...blank, text: "B" }]);
            renderSection();
            const grip = screen.getByRole("button", { name: "Reorder rule 2" });
            grip.focus();
            await key(grip, "Space");
            await key(grip, "ArrowUp");
            await key(grip, "Escape");
            expect(texts()).toEqual(["A", "B"]);
            expect(document.body.textContent).toMatch(/Move canceled/);
            await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS); });
            expect(state.queue).not.toHaveBeenCalled();
        });

        it("dropping a rule where it was writes nothing", async () => {
            state.keyboard = board([{ ...blank, text: "A" }, { ...blank, text: "B" }]);
            renderSection();
            const grip = screen.getByRole("button", { name: "Reorder rule 1" });
            grip.focus();
            await key(grip, "Space");
            await key(grip, "Space");
            expect(texts()).toEqual(["A", "B"]);
            await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS); });
            expect(state.queue).not.toHaveBeenCalled();
        });
    });

    it("deletes a rule; the others keep their order and numbers follow", () => {
        state.keyboard = board([{ ...blank, text: "A" }, { ...blank, text: "B" }, { ...blank, text: "C" }]);
        const view = renderSection();
        fireEvent.click(screen.getByRole("button", { name: "Delete rule 1" }));
        view.rerender();
        expect(state.keyboard!.app_rules!.map((r) => r.text)).toEqual(["B", "C"]);
        expect(screen.getByRole("button", { name: "Reorder rule 2" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Reorder rule 3" })).toBeNull();
    });

    it("older firmware: the grips are disabled", () => {
        state.keyboard = { ...board([{ ...blank, text: "A" }, { ...blank, text: "B" }]), app_rules_format: 1 } as KeyboardInfo;
        renderSection();
        expect((screen.getByRole("button", { name: "Reorder rule 1" }) as HTMLButtonElement).matches(":disabled")).toBe(true);
    });

    it("can't add past 64", () => {
        // Two layers keep 64 rules' pills quick to render.
        state.keyboard = { ...board(Array.from({ length: 64 }, () => ({ ...blank }))), layers: 2 };
        renderSection(true);
        expect((screen.getByRole("button", { name: /Add rule/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("an unknown app shows its text and ID; the Host's running apps name it and offer a picker", async () => {
        state.keyboard = board([{ ...blank, appId: appId("firefox"), text: "Fox", key: undefined }]);
        const view = renderSection();
        expect((screen.getByLabelText("Rule 1 app") as HTMLInputElement).placeholder).toBe("Fox (ID F4D4D03A)");
        expect(screen.queryByTestId("app-rule-pick")).toBeNull();
        state.hostApps = { platform: "linux", foreground: null, apps: [{ key: "firefox", name: "Firefox" }, { key: "gedit", name: "Text Editor" }] };
        view.unmount();
        const again = renderSection();
        await act(async () => { await Promise.resolve(); });
        again.rerender();
        expect(state.keyboard!.app_rules![0].key).toBe("firefox");
        again.rerender();
        fireEvent.change(screen.getByTestId("app-rule-pick"), { target: { value: "gedit" } });
        again.rerender();
        expect(state.keyboard!.app_rules![0]).toMatchObject({ key: "gedit", appId: appId("gedit") });
        expect(screen.getByLabelText("Rule 1 app").getAttribute("title")).toMatch(/WM_CLASS/);
    });

    it("marks the rule that applies now", async () => {
        state.keyboard = board([{ ...blank }]);
        renderSection();
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId("app-rule-active")).toBeTruthy();
    });

    it("offline (no board connected) edits show but nothing is queued", async () => {
        state.connected = false;
        state.keyboard = board([]);
        renderSection();
        fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
        await act(async () => { vi.advanceTimersByTime(APP_RULES_WRITE_DELAY_MS * 2); });
        expect(state.keyboard!.app_rules).toHaveLength(1);
        expect(state.queue).not.toHaveBeenCalled();
    });
    it("a Website rule: the site sets the ID and the whole site is kept, with the hint, and a site that isn't one name is flagged", async () => {
        state.hostApps = { platform: "windows", foreground: null, apps: [] }; // the hint is Windows' (CI runs on Linux)
        state.keyboard = board([{ ...blank }]);
        const view = renderSection();
        await act(async () => { await Promise.resolve(); });
        expect(screen.queryByTestId("app-rule-site")).toBeNull();
        fireEvent.change(screen.getByTestId("app-rule-kind"), { target: { value: "site" } });
        view.rerender();
        expect((screen.getByLabelText("Rule 1 website") as HTMLInputElement).placeholder).toBe("example.com");
        fireEvent.change(screen.getByLabelText("Rule 1 website"), { target: { value: "https://cad.Onshape.com/documents" } });
        view.rerender();
        expect(state.keyboard!.app_rules![0]).toMatchObject({ key: "site:https://cad.Onshape.com/documents", appId: 0x7E364D67, text: "cad.onshape.com", flags: 2 });
        expect(screen.getByTestId("app-rule-site-hint").textContent).toBe("Matches cad.onshape.com and every address under it.");
        fireEvent.change(screen.getByLabelText("Rule 1 website"), { target: { value: "onshape.com" } });
        view.rerender();
        expect(state.keyboard!.app_rules![0]).toMatchObject({ appId: 0xB2AF5B45, text: "onshape.com" });
        expect(screen.queryByLabelText("Rule 1 label")).toBeNull();
        expect(screen.queryByTestId("app-rule-pick")).toBeNull();
        fireEvent.change(screen.getByLabelText("Rule 1 website"), { target: { value: "on shape.com" } });
        view.rerender();
        expect(screen.getByRole("alert").textContent).toMatch(/without spaces/);
        expect(state.keyboard!.app_rules![0].appId).toBe(0);
        fireEvent.change(screen.getByTestId("app-rule-kind"), { target: { value: "program" } });
        view.rerender();
        expect(state.keyboard!.app_rules![0]).toMatchObject({ key: "", appId: 0, text: "", flags: 0 });
        expect(screen.getByLabelText("Rule 1 app")).toBeTruthy();
    });

    it("a website rule read from the board shows as one", () => {
        state.keyboard = board([{ ...blank, appId: appId("site:onshape.com"), text: "onshape.com", flags: 2, key: "site:onshape.com" }]);
        renderSection();
        expect((screen.getByTestId("app-rule-kind") as HTMLSelectElement).value).toBe("site");
        expect((screen.getByLabelText("Rule 1 website") as HTMLInputElement).value).toBe("onshape.com");
    });

    it("a site cut short by the old format shows as it is and asks to be retyped", () => {
        state.keyboard = board([{ ...blank, appId: appId("site:practice.svalboard.com"), text: "…lboard.com", flags: 2, key: undefined }]);
        renderSection();
        expect((screen.getByTestId("app-rule-kind") as HTMLSelectElement).value).toBe("site");
        expect((screen.getByLabelText("Rule 1 website") as HTMLInputElement).placeholder).toBe("…lboard.com");
        expect(screen.getByTestId("app-rule-site-hint").textContent).toBe("Retype this site to edit it.");
    });

    it("on Linux, a website rule says websites work on Windows and Mac for now; on macOS it matches", async () => {
        state.hostApps = { platform: "linux", foreground: null, apps: [] };
        state.keyboard = board([{ ...blank, key: "site:onshape.com", appId: appId("site:onshape.com"), text: "onshape.com", flags: 2 }]);
        const view = renderSection();
        await act(async () => { await Promise.resolve(); });
        view.rerender();
        expect(screen.getByTestId("app-rule-site-hint").textContent).toBe("Websites work on Windows and Mac for now.");
        view.unmount();
        state.hostApps = { platform: "macos", foreground: null, apps: [] };
        const mac = renderSection();
        await act(async () => { await Promise.resolve(); });
        mac.rerender();
        expect(screen.getByTestId("app-rule-site-hint").textContent).toBe("Matches onshape.com and every address under it.");
        expect(screen.getByLabelText("Rule 1 website").getAttribute("title")).toMatch(/Safari, Chrome, Edge, Brave, Arc and Vivaldi/);
    });
});
