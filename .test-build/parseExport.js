"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTikTokExportZip = parseTikTokExportZip;
const jszip_1 = __importDefault(require("jszip"));
const MAX_EVENTS = 150000;
const PREVIEW_LEN = 220;
function normalizeZipPath(p) {
    return p.replaceAll("\\", "/").replace(/^\/+/, "");
}
function truncate(s, n) {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length <= n ? t : `${t.slice(0, n)}…`;
}
function coerceDate(value) {
    if (typeof value === "number") {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed)
            return null;
        const d = new Date(trimmed);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
}
function pickDate(obj) {
    for (const [k, v] of Object.entries(obj)) {
        if (!/date|time|timestamp|created/i.test(k))
            continue;
        const iso = coerceDate(v);
        if (iso)
            return iso;
    }
    for (const v of Object.values(obj)) {
        const iso = coerceDate(v);
        if (iso)
            return iso;
    }
    return null;
}
function primitiveFromPath(path) {
    const p = path.toLowerCase();
    if (p.includes("search"))
        return "intent";
    if (p.includes("like") || p.includes("favorite") || p.includes("follow"))
        return "preference";
    if (p.includes("comment") || p.includes("message") || p.includes("chat"))
        return "social";
    if (p.includes("login") || p.includes("device") || p.includes("setting"))
        return "account";
    if (p.includes("activity") ||
        p.includes("browse") ||
        p.includes("watch") ||
        p.includes("video")) {
        return "attention";
    }
    return "unknown";
}
function labelFromRecord(obj) {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
        if (parts.length >= 4)
            break;
        if (typeof v === "string" && v.trim())
            parts.push(`${k}: ${truncate(v, 80)}`);
        else if (typeof v === "number")
            parts.push(`${k}: ${v}`);
    }
    if (!parts.length)
        return "Record";
    return parts.join(" · ");
}
function previewRecord(obj) {
    try {
        return truncate(JSON.stringify(obj), PREVIEW_LEN);
    }
    catch {
        return "[unserializable record]";
    }
}
/**
 * Module-scope monotonic counter for event IDs.
 *
 * Determinism invariant: event IDs are stable across runs *if and only if*
 * `parseTikTokExportZip` is the sole entrypoint for event construction and
 * is called at most once at a time. The entrypoint resets this counter to 0
 * before parsing, and JSZip's ZIP iteration order is then re-sorted
 * alphabetically by path, so a given archive always produces the same
 * ID sequence.
 *
 * If future code calls `objectToEvent` / `walkJsonForEvents` directly or
 * interleaves multiple parses, IDs will drift. The inference pipeline does
 * not depend on ID values for scoring (IDs are used only as stable keys
 * across derived maps), so drift would break the report's `events[].id`
 * but not change any row's verdict.
 */
let idCounter = 0;
function nextId(prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}
function objectToEvent(obj, sourceFile, jsonPath) {
    const at = pickDate(obj);
    const primitive = primitiveFromPath(`${sourceFile} ${jsonPath}`);
    return {
        id: nextId("ev"),
        sourceFile,
        jsonPath,
        primitive,
        label: labelFromRecord(obj),
        at,
        rawPreview: previewRecord(obj),
    };
}
function walkJsonForEvents(data, sourceFile, jsonPath, out) {
    if (out.length >= MAX_EVENTS)
        return;
    if (Array.isArray(data)) {
        data.forEach((item, i) => {
            if (out.length >= MAX_EVENTS)
                return;
            if (item && typeof item === "object" && !Array.isArray(item)) {
                const ev = objectToEvent(item, sourceFile, `${jsonPath}[${i}]`);
                if (ev)
                    out.push(ev);
            }
            else if (item !== null && item !== undefined) {
                out.push({
                    id: nextId("ev"),
                    sourceFile,
                    jsonPath: `${jsonPath}[${i}]`,
                    primitive: primitiveFromPath(sourceFile),
                    label: truncate(String(item), 120),
                    at: null,
                    rawPreview: truncate(String(item), PREVIEW_LEN),
                });
            }
        });
        return;
    }
    if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
            if (out.length >= MAX_EVENTS)
                return;
            if (typeof v === "string")
                continue;
            walkJsonForEvents(v, sourceFile, `${jsonPath}.${k}`, out);
        }
    }
}
function parseActivityTxt(content, sourceFile, out) {
    const lines = content.split(/\r?\n/);
    let buf = [];
    let currentDate = null;
    const flush = () => {
        if (!buf.length)
            return;
        const text = buf.join("\n");
        const at = currentDate ? coerceDate(currentDate) : null;
        out.push({
            id: nextId("txt"),
            sourceFile,
            primitive: primitiveFromPath(sourceFile),
            label: truncate(text.replace(/\s+/g, " "), 160),
            at,
            rawPreview: truncate(text, PREVIEW_LEN),
        });
        buf = [];
    };
    for (const line of lines) {
        if (out.length >= MAX_EVENTS)
            break;
        const dateLine = line.match(/^Date:\s*(.+)$/i)?.[1]?.trim() ??
            line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^\n]*)$/)?.[1]?.trim();
        if (dateLine) {
            flush();
            currentDate = dateLine;
            buf.push(line);
        }
        else if (currentDate) {
            buf.push(line);
        }
    }
    flush();
}
async function collectPointerEvents(zip, root, warnings) {
    const out = [];
    if (!root || typeof root !== "object" || Array.isArray(root))
        return out;
    for (const v of Object.values(root)) {
        if (typeof v !== "string")
            continue;
        const p = normalizeZipPath(v);
        if (!/\.(txt|json)$/i.test(p))
            continue;
        const file = zip.file(p);
        if (!file) {
            warnings.push(`Referenced path not found in ZIP: ${p}`);
            continue;
        }
        try {
            const text = await file.async("string");
            if (p.toLowerCase().endsWith(".json")) {
                const json = JSON.parse(text);
                walkJsonForEvents(json, p, "$", out);
            }
            else {
                parseActivityTxt(text, p, out);
            }
        }
        catch (e) {
            warnings.push(`Failed to parse referenced file ${p}: ${e.message}`);
        }
        if (out.length >= MAX_EVENTS)
            break;
    }
    return out;
}
async function parseTikTokExportZip(file) {
    idCounter = 0;
    const warnings = [];
    const buffer = await file.arrayBuffer();
    const zip = await jszip_1.default.loadAsync(buffer);
    const inventory = [];
    zip.forEach((relativePath, entry) => {
        if (entry.dir)
            return;
        inventory.push({ path: relativePath });
    });
    inventory.sort((a, b) => a.path.localeCompare(b.path));
    const events = [];
    const jsonFiles = inventory.filter((i) => i.path.toLowerCase().endsWith(".json"));
    for (const meta of jsonFiles) {
        if (events.length >= MAX_EVENTS)
            break;
        const f = zip.file(meta.path);
        if (!f)
            continue;
        try {
            const text = await f.async("string");
            const json = JSON.parse(text);
            walkJsonForEvents(json, meta.path, "$", events);
            if (meta.path.toLowerCase().includes("user_data")) {
                const pointerEvents = await collectPointerEvents(zip, json, warnings);
                for (const e of pointerEvents) {
                    if (events.length >= MAX_EVENTS)
                        break;
                    events.push(e);
                }
            }
        }
        catch (e) {
            warnings.push(`JSON parse failed for ${meta.path}: ${e.message}`);
        }
    }
    const orphanTxt = inventory.filter((i) => i.path.toLowerCase().endsWith(".txt") && !events.some((e) => e.sourceFile === i.path));
    for (const meta of orphanTxt) {
        if (events.length >= MAX_EVENTS)
            break;
        const f = zip.file(meta.path);
        if (!f)
            continue;
        try {
            const text = await f.async("string");
            parseActivityTxt(text, meta.path, events);
        }
        catch (e) {
            warnings.push(`TXT read failed for ${meta.path}: ${e.message}`);
        }
    }
    const dated = events.filter((e) => e.at);
    dated.sort((a, b) => (a.at < b.at ? -1 : 1));
    const undated = events.filter((e) => !e.at);
    const merged = [...dated, ...undated];
    if (!merged.length) {
        warnings.push("No events were extracted. TikTok exports differ by region/version—try JSON format, ensure the ZIP is complete, and check that referenced TXT/JSON paths exist inside the archive.");
    }
    return { inventory, warnings, events: merged.slice(0, MAX_EVENTS) };
}
