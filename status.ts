/**
 * The live status message: pi's tool calls during a run, roughly as a terminal shows them.
 * Each call is one line. The latest one also shows its output, diff or file, the latest
 * image pi read sits beside its line, and one temporary line shows what pi is thinking or
 * writing until it acts. Kept free of pi imports so a script can replay a run through it.
 */

import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { AttachmentBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";

const ICONS = { running: "⏳", done: "✅", error: "❌" } as const;
const MAX_LINES = 20;
/** Lines of output, diff or file shown under the latest call. */
const PREVIEW_LINES = 8;
/** Lines before an image's own line that share its row, so the thumbnail isn't taller than its text. */
const IMAGE_CONTEXT = 3;
const HOME = homedir();

/** A downscaled image, uploaded with the message that shows it. */
export interface Thumb {
	name: string;
	data: Buffer;
	alt: string;
}

export interface ToolLine {
	id: string;
	name: string;
	args: Record<string, unknown>;
	state: keyof typeof ICONS;
	since: number;
	ms?: number;
	/** Text output: streamed while it runs, then the result. */
	output?: string;
	/** Unified patch, for edits. */
	patch?: string;
	image?: Thumb;
}

export interface Status {
	tools: ToolLine[];
	/** What pi is doing before its next tool call. */
	pending?: { key: string; text: string; since: number };
	done: boolean;
}

/** Status text, split around the section that shows the latest image. */
export interface StatusView {
	before: string;
	section?: { text: string; image: Thumb };
	after: string;
}

/** "1 line", "2 lines". */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Text squeezed onto one line, safe inside inline code. */
export function oneLine(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
	return line.length > max ? `${line.slice(0, max - 3)}…` : line;
}

/** The start of the latest paragraph long enough to say something. */
export function describeThought(thinking: string): string {
	const paragraphs = thinking
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	const thought = oneLine(paragraphs.findLast((p) => p.length >= 40) ?? paragraphs.at(-1) ?? "");
	return thought ? `💭 \`${thought}\`` : "💭";
}

/** A path relative to cwd when inside it, else with ~ for home. */
function tidyPath(path: string, cwd: string): string {
	const absolute = resolve(cwd, path.replace(/^~(?=\/|$)/, HOME));
	const inside = relative(cwd, absolute);
	if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
	return absolute === HOME || absolute.startsWith(`${HOME}/`) ? `~${absolute.slice(HOME.length)}` : absolute;
}

/** A command as a prompt line: a leading `cd dir &&` becomes the prompt, as in a shell. */
function describeCommand(command: string): string {
	const cd = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\n)\s*/);
	let prompt = "$";
	if (cd) {
		const dir = cd[1].replace(/^["']|["']$/g, "").replace(/\/+$/, "");
		prompt = `${basename(dir) || dir} $`;
		command = command.slice(cd[0].length);
	}
	return `\`${oneLine(`${prompt} ${command.replaceAll(HOME, "~")}`, 72)}\``;
}

function patchStats(patch: string): string {
	const lines = patch.split("\n");
	const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
	const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
	return `+${added} −${removed}`;
}

/** One line for a call, from its name and (possibly partial) arguments. */
export function describeCall(name: string, args: Record<string, unknown>, cwd: string, patch?: string): string {
	const rawPath = args.path ?? args.file_path;
	const path = typeof rawPath === "string" && rawPath ? `\`${oneLine(tidyPath(rawPath, cwd), 72)}\`` : "";
	if (name === "bash" && typeof args.command === "string") return describeCommand(args.command);
	if (name === "read" && path) {
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		const first = offset ?? 1;
		const last = limit ? first + limit - 1 : undefined;
		const range = !offset && !limit ? "" : last === first ? ` · line ${first}` : ` · lines ${first}–${last ?? ""}`;
		return `**read** ${path}${range}`;
	}
	if (name === "edit" && path) return `**edit** ${path}${patch ? ` · ${patchStats(patch)}` : ""}`;
	if (name === "write" && path && typeof args.content === "string") {
		return `**write** ${path} · ${plural(args.content.split("\n").length, "line")}`;
	}
	const key = ["command", "path", "file_path", "pattern", "query", "url", "paths"].find((k) => args[k] !== undefined);
	let detail = key ? args[key] : Object.keys(args).length > 0 ? args : "";
	if (typeof detail !== "string") detail = JSON.stringify(detail);
	const summary = oneLine(detail as string);
	return summary ? `**${name}** \`${summary}\`` : `**${name}**`;
}

function duration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Output lines, without pi's closing status line and the exit code it gives. */
function outputLines(output: string): { lines: string[]; code?: string } {
	const lines = output.replace(ANSI, "").replace(/\r\n?/g, "\n").trimEnd().split("\n");
	const code = lines.at(-1)?.match(/^Command exited with code (\d+)$/)?.[1];
	if (code) lines.pop();
	while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
	return { lines, code };
}

/** Why a call failed, in one line: its exit code and last line of output. */
function failure(tool: ToolLine): string {
	const { lines, code } = outputLines(tool.output ?? "");
	const reason = (tool.name === "bash" ? lines.findLast((l) => l.trim()) : lines.find((l) => l.trim())) ?? "";
	const parts = [code && `exit ${code}`, reason && `\`${oneLine(reason, 100)}\``].filter(Boolean);
	return parts.length > 0 ? `\n-# ${parts.join(" · ")}` : "";
}

/** A fenced block that can't be closed early by what's inside it. */
function fence(lang: string, lines: string[]): string {
	const body = lines.map((line) => {
		const tidy = line.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length)).replaceAll("```", "`​``");
		return tidy.length > 120 ? `${tidy.slice(0, 119)}…` : tidy;
	});
	return `\`\`\`${lang}\n${body.join("\n")}\n\`\`\``;
}

const more = (count: number) => (count > 0 ? `\n-# … ${plural(count, "more line")}` : "");

/** Changed lines of a patch with one line of context around them. */
function previewPatch(patch: string): string {
	const lines = patch.split("\n").filter((line) => /^[ +-]/.test(line) && !/^(\+\+\+|---) /.test(line));
	const changed = lines.map((line) => line[0] !== " ");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!changed[i] && !changed[i - 1] && !changed[i + 1]) {
			if (kept.at(-1) !== " ⋯") kept.push(" ⋯");
			continue;
		}
		kept.push(lines[i]);
	}
	while (kept[0] === " ⋯") kept.shift();
	while (kept.at(-1) === " ⋯") kept.pop();
	const shown = kept.slice(0, PREVIEW_LINES + 4);
	return fence("diff", shown) + more(kept.length - shown.length);
}

/** What the latest call produced, shown under its line. */
function preview(tool: ToolLine): string | undefined {
	if (tool.patch) return previewPatch(tool.patch);
	if (tool.name === "write" && typeof tool.args.content === "string") {
		const path = String(tool.args.path ?? tool.args.file_path ?? "");
		const lines = tool.args.content.split("\n");
		return fence(extname(path).slice(1), lines.slice(0, PREVIEW_LINES)) + more(lines.length - PREVIEW_LINES);
	}
	if (!tool.output || tool.image || ["read", "edit", "write"].includes(tool.name)) return undefined;
	const { lines } = outputLines(tool.output);
	if (lines.length === 0) return undefined;
	const shown = lines.slice(-PREVIEW_LINES);
	const hidden = lines.length - shown.length;
	const block =
		tool.state === "error"
			? fence(
					"ansi",
					shown.map((line) => `\x1b[31m${line}\x1b[0m`),
				)
			: fence("", shown);
	return (hidden > 0 ? `-# … ${plural(hidden, "earlier line")}\n` : "") + block;
}

/** The status message as text, newest calls winning when it would run past `maxChars`. */
export function renderStatus(status: Status, cwd: string, maxChars: number, images = true): StatusView {
	const { tools, pending, done } = status;
	const failed = tools.filter((tool) => tool.state === "error").length;
	const header = `-# ${done ? "✓" : "🔧"} ${plural(tools.length, "tool call")}${failed ? ` · ${failed} failed` : ""}`;
	// Discord keeps these counting up, so live lines need no edits to show how long they've taken.
	const ago = (since: number) => ` · <t:${Math.floor(since / 1000)}:R>`;

	const last = tools.at(-1);
	const extra = last && preview(last);
	const lines = tools.map((tool) => {
		let line = `${ICONS[tool.state]} ${describeCall(tool.name, tool.args, cwd, tool.patch)}`;
		if (tool.state === "running" && !done) line += ago(tool.since);
		else if (tool.ms !== undefined && tool.ms >= 5000) line += ` · ${duration(tool.ms)}`;
		if (tool.state === "error" && !(tool === last && extra)) line += failure(tool);
		return line;
	});
	const tail = [extra, pending && !done ? pending.text + ago(pending.since) : undefined].filter(Boolean).join("\n");

	let budget = maxChars - header.length - tail.length - 40;
	let first = lines.length;
	while (first > 0 && lines.length - first < MAX_LINES && (first === lines.length || budget >= lines[first - 1].length + 1)) {
		budget -= lines[--first].length + 1;
	}
	const head = [header, ...(first > 0 ? [`-# … ${first} earlier`] : [])];
	const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join("\n");

	const imageAt = images ? tools.findLastIndex((tool) => tool.image) : -1;
	const image = tools[imageAt]?.image;
	if (!image || imageAt < first) return { before: join([...head, ...lines.slice(first), tail]), after: "" };
	const start = Math.max(first, imageAt - IMAGE_CONTEXT);
	const end = Math.min(lines.length, imageAt + IMAGE_CONTEXT + 1);
	return {
		before: join([...head, ...lines.slice(first, start)]),
		section: { text: lines.slice(start, end).join("\n"), image },
		after: join([...lines.slice(end), tail]),
	};
}

/**
 * Components v2 options for a status message. `attached` names the image the message
 * already has: it's kept as is, and any other image replaces it.
 */
export function statusPayload(view: StatusView, attached?: string) {
	const text = (content: string) => new TextDisplayBuilder().setContent(content);
	const components: (TextDisplayBuilder | SectionBuilder)[] = [text(view.before)];
	const image = view.section?.image;
	if (view.section && image) {
		components.push(
			new SectionBuilder()
				.addTextDisplayComponents(text(view.section.text))
				.setThumbnailAccessory(new ThumbnailBuilder().setURL(`attachment://${image.name}`).setDescription(image.alt.slice(0, 1024))),
		);
	}
	if (view.after) components.push(text(view.after));
	if (image?.name === attached) return { components };
	return { components, files: image ? [new AttachmentBuilder(image.data, { name: image.name })] : [], attachments: [] };
}
