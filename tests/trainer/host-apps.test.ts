import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHostApps, parseHostApps, resetHostAppsForTests } from "@/features/trainer/host-apps";

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("Keybard Host running apps", () => {
    beforeEach(() => { resetHostAppsForTests(); document.documentElement.dataset.keybardHost = "true"; });
    afterEach(() => { delete document.documentElement.dataset.keybardHost; localStorage.clear(); vi.unstubAllGlobals(); });

    it("parses and cleans the reply", () => {
        expect(parseHostApps({ platform: "windows", foreground: { key: "notepad.exe", name: "Notepad" },
            apps: [{ key: "zed.exe", name: "Zed" }, { key: "notepad.exe", name: "Notepad" }, { key: "zed.exe", name: "dup" }, { key: "", name: "x" }, 5] }))
            .toEqual({ platform: "windows", foreground: { key: "notepad.exe", name: "Notepad" }, apps: [{ key: "notepad.exe", name: "Notepad" }, { key: "zed.exe", name: "Zed" }] });
        expect(parseHostApps({ platform: "beos", apps: [] })).toBeNull();
        expect(parseHostApps(null)).toBeNull();
    });

    it("asks with the Host's token, and an older Host (404) gives no list", async () => {
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/host/bootstrap")) return json(200, { apiVersion: 1, token: "t1" });
            expect((init?.headers as Record<string, string>)["X-Keybard-Token"]).toBe("t1");
            return json(200, { platform: "macos", foreground: null, apps: [{ key: "com.apple.Safari", name: "Safari" }] });
        });
        vi.stubGlobal("fetch", fetchMock);
        expect(await fetchHostApps()).toEqual({ platform: "macos", foreground: null, apps: [{ key: "com.apple.Safari", name: "Safari" }] });
        expect(fetchMock.mock.calls[1][0]).toBe("/api/host/apps");
        fetchMock.mockImplementation(async () => json(404, { error: "Unknown API" }));
        expect(await fetchHostApps()).toBeNull();
    });

    it("never asks when no Host is in use", async () => {
        delete document.documentElement.dataset.keybardHost;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect(await fetchHostApps()).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetches a new token after a Host restart (403)", async () => {
        let tokens = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/bootstrap")) return json(200, { apiVersion: 1, token: `t${++tokens}` });
            return (init?.headers as Record<string, string>)["X-Keybard-Token"] === "t2" ? json(200, { platform: "linux", apps: [] }) : json(403, {});
        }));
        expect(await fetchHostApps()).toEqual({ platform: "linux", foreground: null, apps: [] });
    });
});
