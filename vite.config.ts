import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, loadEnv } from "vite";
import { execSync } from "child_process";
import { paranoidPlugins, bundledLayersPlugin } from "./build/paranoid";
import { currentSite, versionFile } from "./src/constants/firmware-releases";

// Get current git branch for labeling and port assignment.
// Falls back to env var (set by CI: GitHub Actions detached-HEAD checkouts
// don't have a branch name, so the workflow passes it through GIT_BRANCH).
function getGitBranch(): string {
    if (process.env.GIT_BRANCH) return process.env.GIT_BRANCH;
    try {
        const branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
        return branch || "unknown";
    } catch {
        return "unknown";
    }
}

function getGitSha(): string {
    if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 7);
    try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    } catch {
        return "";
    }
}

// The release tag a release build is built from (v3, x3.1): set by the deploy
// and Keybard Overlay workflows. Empty for every other build.
function getReleaseTag(): string {
    return process.env.RELEASE_TAG?.trim() ?? "";
}

function getGitSubject(): string {
    if (process.env.GIT_SUBJECT) return process.env.GIT_SUBJECT.split("\n")[0];
    try {
        return execSync("git log -1 --pretty=%s", { encoding: "utf-8" }).trim();
    } catch {
        return "";
    }
}

// Assign ports based on branch name for parallel development
function getPortForBranch(branch: string): number {
    const portMap: Record<string, number> = {
        "main": 5170,
        "viable-protocol-migration": 5171,
        "feature/explore-layouts": 5172,
        "feature/layout-library-panel": 9876,
        "feature/oneshot-composer": 5174,
    };
    return portMap[branch] ?? 5173; // Default fallback port
}

const gitBranch = getGitBranch();
const gitSha = getGitSha();
const gitSubject = getGitSubject();
const releaseTag = getReleaseTag();
const devPort = getPortForBranch(gitBranch);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const paranoid = mode === "paranoid";
    return {
    base: env.VITE_BASE_PATH || "/keybard/",
    plugins: [
        react(),
        tailwindcss(),
        bundledLayersPlugin(paranoid, path.resolve(__dirname)),
        ...(paranoid ? paranoidPlugins(path.resolve(__dirname)) : []),
        {
            // version.json at the site root names the release this deploy serves,
            // so the other site can show it (src/utils/site-versions.ts). Only
            // release builds have one; Paranoid is a single file and has none.
            name: "keybard-version-file",
            apply: "build",
            generateBundle() {
                const site = currentSite({ MODE: mode, VITE_CHANNEL: env.VITE_CHANNEL, BASE_URL: env.VITE_BASE_PATH });
                const file = paranoid ? null : versionFile(releaseTag, site);
                if (!file) return;
                this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify(file)}\n` });
            },
        },
        {
            name: "git-branch-endpoint",
            configureServer(server) {
                server.middlewares.use("/__git_branch", (_req, res) => {
                    try {
                        const branch = getGitBranch();
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ branch }));
                    } catch {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ branch: "unknown" }));
                    }
                });
            }
        }
    ],
    root: "src",
    envDir: path.resolve(__dirname),
    publicDir: paranoid ? false : "../public",
    build: {
        outDir: paranoid ? "../dist-paranoid" : "../dist",
        emptyOutDir: true,
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    define: {
        __GIT_BRANCH__: JSON.stringify(gitBranch),
        __GIT_SHA__: JSON.stringify(gitSha),
        __GIT_SUBJECT__: JSON.stringify(gitSubject),
        __RELEASE_TAG__: JSON.stringify(releaseTag),
    },
    server: {
        port: devPort,
        strictPort: true,
    },
};
});
