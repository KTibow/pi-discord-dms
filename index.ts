/**
 * pi-discord-dms — talk to one pi session from one Discord DM.
 *
 * Replies are "armed" by a Discord message: from the moment a [discord] user
 * message enters the transcript until the agent settles (or a non-Discord user
 * message takes over), assistant text and tool progress are forwarded to the DM.
 * Runs started by a local (TUI/RPC) user message stay local. Runs woken by another
 * extension (custom messages, or user messages it sends) or continuing on their own
 * forward only assistant text, since the agent chose not to reply [silent].
 *
 * /yo and the "Send to pi" message action bring in text, files or a message from any
 * channel. Pi still answers in the DM.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type APIMessage,
	type ApplicationCommandData,
	ApplicationCommandType,
	ApplicationIntegrationType,
	AttachmentBuilder,
	Client,
	type DMChannel,
	Events,
	FileUploadBuilder,
	GatewayIntentBits,
	type Interaction,
	InteractionContextType,
	LabelBuilder,
	Message,
	MessageFlags,
	MessageReferenceType,
	ModalBuilder,
	Partials,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { Type } from "typebox";

const DIR = join(getAgentDir(), "discord-dms");
const CONFIG_FILE = join(DIR, "config.json");
const LOCK_FILE = join(DIR, "lock.json");
const INBOX_DIR = join(DIR, "inbox");

const PREFIX = "[discord]";
const INTERNAL_PREFIX = "__from-discord:";
const ENTRY_TYPE = "discord-dms";
const TOOL_NAME = "discord_send_files";
const MAX_CHUNK = 1900;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const STATUS_THROTTLE_MS = 1500;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Built-ins reimplemented for Discord; the rest need the TUI. */
const DISCORD_BUILTINS = ["help", "stop", "compact", "model", "thinking", "name", "session", "new", "reload"];
const TUI_BUILTINS = ["settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "resume", "quit"];
const MAX_STATUS_LINES = 20;
const TOOL_ICONS = { running: "⏳", done: "✅", error: "❌" } as const;
const YO_COMMAND = "yo";
const SHARE_COMMAND = "Send to pi";
const SHARE_PREFIX = "share:";
const SHARE_TTL_MS = 15 * 60 * 1000;
const MODAL_TEXT = "text";
const MODAL_FILES = "files";

interface ToolLine {
	id: string;
	text: string;
	state: keyof typeof TOOL_ICONS;
}

interface IncomingFile {
	url: string;
	name: string;
	contentType: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Config and single-owner lock
// ---------------------------------------------------------------------------

interface Config {
	token?: string;
	userId?: string;
}

function loadConfig(): Config {
	let file: Config = {};
	try {
		file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch {}
	return {
		token: process.env.PI_DISCORD_BOT_TOKEN || file.token,
		userId: process.env.PI_DISCORD_USER_ID || file.userId,
	};
}

function saveConfig(config: Config): void {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(CONFIG_FILE, 0o600);
}

function readLockPid(): number | undefined {
	try {
		const pid = JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid;
		return typeof pid === "number" ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** PID of another live pi process that owns the DM, if any. */
function otherLockHolder(): number | undefined {
	const pid = readLockPid();
	return pid !== undefined && pid !== process.pid && isAlive(pid) ? pid : undefined;
}

function ownsLock(): boolean {
	return readLockPid() === process.pid;
}

function writeLock(): void {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
}

function releaseLock(): void {
	if (!ownsLock()) return;
	try {
		unlinkSync(LOCK_FILE);
	} catch {}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function textOf(content: string | (TextContent | ImageContent | { type: string })[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isSilent(text: string): boolean {
	return text === "" || /^\[silent\]$/i.test(text);
}

/** Split text into Discord-sized chunks on line boundaries, re-opening code fences across chunks. */
function chunkText(text: string, max = MAX_CHUNK): string[] {
	const chunks: string[] = [];
	let lines: string[] = [];
	let length = 0;
	let fence: string | undefined;

	const flush = () => {
		if (lines.length === 0) return;
		chunks.push(fence ? `${lines.join("\n")}\n\`\`\`` : lines.join("\n"));
		lines = fence ? [fence] : [];
		length = fence ? fence.length : 0;
	};

	for (const line of text.split("\n")) {
		const pieces = line.length > max - 10 ? (line.match(new RegExp(`[\\s\\S]{1,${max - 10}}`, "g")) ?? [line]) : [line];
		for (const piece of pieces) {
			if (length + piece.length + 1 + (fence ? 4 : 0) > max) flush();
			lines.push(piece);
			length += piece.length + 1;
			const match = piece.match(/^\s*```(.*)$/);
			if (match) fence = fence ? undefined : `\`\`\`${match[1].trim()}`;
		}
	}
	if (lines.some((line) => line.trim() !== "")) chunks.push(lines.join("\n"));
	return chunks;
}

function describeTool(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const key = ["command", "path", "file_path", "pattern", "query", "url", "paths"].find((k) => a[k] !== undefined);
	let detail = key ? a[key] : Object.keys(a).length > 0 ? args : "";
	if (typeof detail !== "string") detail = JSON.stringify(detail);
	let summary = (detail as string).replace(/\s+/g, " ").replace(/`/g, "'").trim();
	if (summary.length > 80) summary = `${summary.slice(0, 77)}…`;
	return summary ? `**${name}** \`${summary}\`` : `**${name}**`;
}

/** Context line for a Discord reply, written in the user's voice. */
function describeReply(quoted: Message, fromPi: boolean): string {
	let excerpt = quoted.content.replace(/\s+/g, " ").trim();
	if (excerpt.length > 300) excerpt = `${excerpt.slice(0, 297)}…`;
	if (!excerpt && quoted.attachments.size > 0) {
		excerpt = `attachments: ${[...quoted.attachments.values()].map((a) => a.name).join(", ")}`;
	}
	return `(replying to ${fromPi ? "your" : "my own"} earlier message: "${excerpt}")`;
}

/**
 * Context for a message picked with "Send to pi", in the user's voice. It arrives as
 * raw API data when the bot isn't in that server.
 */
function describeShared(target: Message | APIMessage, where: string, userId: string, botId: string) {
	const author =
		target.author.id === userId
			? "my"
			: target.author.id === botId
				? "your"
				: `${target instanceof Message ? (target.author.globalName ?? target.author.username) : (target.author.global_name ?? target.author.username)}'s`;
	const lines = [`(sharing ${author} message from ${where})`];
	const quote = (text: string) => lines.push(...text.split("\n").map((line) => `> ${line}`));
	if (target.content) quote(target.content);
	for (const embed of target.embeds) {
		const text = [embed.title, embed.description].filter(Boolean).join("\n");
		if (text) quote(`[embed] ${text}`);
	}
	const files: IncomingFile[] =
		target instanceof Message
			? [...target.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType }))
			: target.attachments.map((a) => ({ url: a.url, name: a.filename, contentType: a.content_type }));
	return { lines, files };
}

function shareModal(customId: string, title: string, label: string): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(title)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(label)
				.setTextInputComponent(
					new TextInputBuilder().setCustomId(MODAL_TEXT).setStyle(TextInputStyle.Paragraph).setRequired(false),
				),
			new LabelBuilder()
				.setLabel("Files")
				.setDescription("Screenshots, logs or anything else")
				.setFileUploadComponent(new FileUploadBuilder().setCustomId(MODAL_FILES).setRequired(false).setMaxValues(10)),
		);
}

/** Register /yo and "Send to pi". Returns whether they work outside servers the bot is in. */
async function registerCommands(client: Client): Promise<boolean> {
	const app = await client.application!.fetch();
	const userInstall = app.integrationTypesConfig?.[ApplicationIntegrationType.UserInstall] != null;
	const types = userInstall
		? [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]
		: [ApplicationIntegrationType.GuildInstall];
	const contexts = userInstall
		? [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]
		: [InteractionContextType.Guild, InteractionContextType.BotDM];
	const commands: ApplicationCommandData[] = [
		{
			type: ApplicationCommandType.ChatInput,
			name: YO_COMMAND,
			description: "Send pi a message or files. It replies in your DM",
			integrationTypes: types,
			contexts,
		},
		{ type: ApplicationCommandType.Message, name: SHARE_COMMAND, integrationTypes: types, contexts },
	];
	const existing = await app.commands.fetch();
	if (existing.size !== commands.length || !commands.every((c) => existing.some((e) => e.equals(c)))) {
		await app.commands.set(commands);
	}
	return userInstall;
}

function expandPath(path: string, cwd: string): string {
	if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
	return resolve(cwd, path);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let client: Client | undefined;
	let dm: DMChannel | undefined;
	let connecting: Promise<void> | undefined;
	let ctxRef: ExtensionContext | undefined;
	let userInstallable = false; // /yo works in servers the bot isn't in

	// Reply routing state
	let armed = false;
	let runActive = false; // between agent_start and agent_settled
	let localRun = false; // a non-Discord user message joined this run
	// A ./template or ./skill: from Discord expands without the [discord] prefix, so
	// the next user message is assumed to be it.
	let armNextUser = false;
	// Texts other extensions submitted via sendUserMessage, matched when they reach the
	// transcript so their user messages count as wakes rather than a local takeover.
	const extensionInputs: string[] = [];
	let typingTimer: ReturnType<typeof setInterval> | undefined;

	// Tool-call status message: one live message per armed run, reposted below new text.
	let tools: ToolLine[] = [];
	let statusMsg: Message | undefined;
	let statusStale = false; // text was posted after the status message
	let statusDirty = false;
	let statusDone = false;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	// All Discord writes go through one queue so they land in transcript order.
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task);
		queue = run.catch((err) => ctxRef?.ui.notify(`discord: ${(err as Error).message}`, "error"));
		return run;
	};

	const setToolActive = (active: boolean) => {
		const current = pi.getActiveTools();
		if (current.includes(TOOL_NAME) === active) return;
		const tools = current.filter((name) => name !== TOOL_NAME);
		pi.setActiveTools(active ? [...tools, TOOL_NAME] : tools);
	};

	// --- typing indicator ----------------------------------------------------

	const startTyping = () => {
		if (typingTimer || !dm) return;
		const send = () => dm?.sendTyping().catch(() => {});
		send();
		typingTimer = setInterval(send, 8000);
	};

	const stopTyping = () => {
		if (typingTimer) clearInterval(typingTimer);
		typingTimer = undefined;
	};

	// --- status message --------------------------------------------------------

	const statusText = () => {
		const count = `${tools.length} tool call${tools.length === 1 ? "" : "s"}`;
		const failed = tools.filter((tool) => tool.state === "error").length;
		const header = `-# ${statusDone ? "✓" : "🔧"} ${count}${failed ? ` · ${failed} failed` : ""}`;
		// Newest calls win; older ones collapse into a count so the message stays under Discord's limit.
		const lines: string[] = [];
		let length = header.length;
		for (let i = tools.length - 1; i >= 0 && lines.length < MAX_STATUS_LINES; i--) {
			const line = `${TOOL_ICONS[tools[i].state]} ${tools[i].text}`;
			if (length + line.length + 40 > MAX_CHUNK) break;
			lines.unshift(line);
			length += line.length + 1;
		}
		const hidden = tools.length - lines.length;
		return [header, ...(hidden > 0 ? [`-# … ${hidden} earlier`] : []), ...lines].join("\n");
	};

	// Must run inside the queue.
	const flushStatus = async () => {
		if (!statusDirty || !dm) return;
		statusDirty = false;
		if (statusMsg && !statusStale) {
			await statusMsg.edit(statusText());
			return;
		}
		const previous = statusMsg;
		statusMsg = await dm.send(statusText());
		statusStale = false;
		await previous?.delete().catch(() => {});
	};

	const bumpStatus = () => {
		statusDirty = true;
		if (statusTimer) return;
		const delay = statusMsg && !statusStale ? STATUS_THROTTLE_MS : 0;
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			enqueue(flushStatus);
		}, delay);
	};

	const resetRun = () => {
		tools = [];
		statusMsg = undefined;
		statusStale = false;
		statusDirty = false;
		statusDone = false;
	};

	const finishRun = () => {
		armed = false;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;
		enqueue(async () => {
			if (tools.length > 0) {
				statusDone = true;
				statusDirty = true;
				statusStale = false; // finalize in place rather than reposting
				await flushStatus();
			}
			resetRun();
		});
	};

	/** Post text (and optional files) after any pending status update. */
	const post = (content: string, files: string[] = []) =>
		enqueue(async () => {
			if (!dm) return;
			await flushStatus();
			const chunks = chunkText(content);
			if (chunks.length === 0 && files.length === 0) return;
			for (let i = 0; i < chunks.length; i++) {
				const last = i === chunks.length - 1;
				await dm.send({
					content: chunks[i],
					files: last ? files.map((f) => new AttachmentBuilder(f)) : [],
					allowedMentions: { parse: [] },
				});
			}
			if (chunks.length === 0) await dm.send({ files: files.map((f) => new AttachmentBuilder(f)) });
			if (statusMsg) statusStale = true;
		});

	// --- ./commands -------------------------------------------------------------

	const note = (text: string) => post(`-# ${text}`);

	/** Run a pi slash command sent from Discord as ./command. `line` starts with "/". */
	const runCommand = async (line: string, message: Message, ctx: ExtensionContext) => {
		const space = line.indexOf(" ");
		const name = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase();
		const args = space === -1 ? "" : line.slice(space + 1).trim();
		const ok = () => message.react("✅").catch(() => {});

		switch (name) {
			case "help": {
				const commands = pi.getCommands().map((c) => `\`./${c.name}\`${c.description ? ` ${c.description}` : ""}`);
				void post(
					[
						`**Built-in:** ${DISCORD_BUILTINS.map((n) => `\`./${n}\``).join(" ")}`,
						`**TUI only:** ${TUI_BUILTINS.map((n) => `\`/${n}\``).join(" ")}`,
						...(commands.length > 0 ? ["**Extensions, prompts and skills:**", ...commands] : []),
					].join("\n"),
				);
				return;
			}
			case "stop":
			case "abort":
				ctx.abort();
				await message.react("⏹️").catch(() => {});
				return;
			case "compact":
				await message.react("⏳").catch(() => {});
				ctx.compact({
					customInstructions: args || undefined,
					onComplete: () => void note("compacted"),
					onError: (err) => void note(`compaction failed: ${err.message}`),
				});
				return;
			case "model": {
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				if (!args) {
					void note(`model: ${current}`);
					return;
				}
				const query = args.toLowerCase();
				const models = ctx.modelRegistry.getAvailable();
				const exact = models.filter(
					(m) => `${m.provider}/${m.id}`.toLowerCase() === query || m.id.toLowerCase() === query,
				);
				const matches = exact.length > 0 ? exact : models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query));
				if (matches.length !== 1) {
					const list = matches.slice(0, 15).map((m) => `\`${m.provider}/${m.id}\``).join(" ");
					void note(matches.length === 0 ? `no model matches "${args}"` : `ambiguous: ${list}`);
					return;
				}
				const model = matches[0];
				if (await pi.setModel(model)) void note(`model: ${model.provider}/${model.id}`);
				else void note(`no credentials for ${model.provider}`);
				return;
			}
			case "thinking": {
				if (args) {
					if (!(THINKING_LEVELS as readonly string[]).includes(args)) {
						void note(`levels: ${THINKING_LEVELS.join(", ")}`);
						return;
					}
					pi.setThinkingLevel(args as (typeof THINKING_LEVELS)[number]);
				}
				void note(`thinking: ${pi.getThinkingLevel()}`);
				return;
			}
			case "name":
				if (args) pi.setSessionName(args);
				void note(`session name: ${pi.getSessionName() ?? "(none)"}`);
				return;
			case "session": {
				const usage = ctx.getContextUsage();
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				void post(
					[
						`**${pi.getSessionName() ?? "unnamed session"}**`,
						`model \`${model}\` · thinking ${pi.getThinkingLevel()}`,
						usage?.percent != null ? `context ${Math.round(usage.percent)}% of ${usage.contextWindow}` : "",
						`cwd \`${ctx.cwd}\``,
						`file \`${ctx.sessionManager.getSessionFile() ?? "(in memory)"}\``,
					]
						.filter(Boolean)
						.join("\n"),
				);
				return;
			}
			case "new":
			case "reload":
				// The TUI's reload refuses mid-run and only warns in the TUI; /new aborts the run itself.
				if (name === "reload" && !ctx.isIdle()) {
					void note("wait for pi to finish before reloading, or ./stop first");
					return;
				}
				// Session replacement needs a command context, which only a registered command gets.
				await note(name === "new" ? "starting a new session now, back in a few seconds" : "reloading now, back in a few seconds");
				pi.sendUserMessage(`/discord ${INTERNAL_PREFIX}${name}`, { expandPromptTemplates: true });
				return;
		}

		if (TUI_BUILTINS.includes(name)) {
			void note(`/${name} only works in the TUI`);
			return;
		}
		const command = pi.getCommands().find((c) => c.name.toLowerCase() === name);
		if (!command) {
			void note(`unknown command /${name}; try ./help`);
			return;
		}
		if (command.source === "extension") {
			// Its output goes to the TUI; acknowledge here.
			pi.sendUserMessage(line, { expandPromptTemplates: true });
			await ok();
			return;
		}
		// Prompt templates and skills expand into a user message that answers to Discord.
		startTyping();
		deliver(() => {
			armNextUser = true;
			pi.sendUserMessage(line, { expandPromptTemplates: true, deliverAs: "steer" });
		});
	};

	// --- delivery -----------------------------------------------------------------

	// prompt() rejects while a manual compaction or branch summary runs, and two prompts
	// sent while idle race to start a run. Deliver one at a time, holding while pi is
	// busy with something other than a run, like the TUI does with typed messages.
	const outbox: Array<() => void> = [];
	let starting: ReturnType<typeof setTimeout> | undefined; // idle send awaiting agent_start
	let outboxTimer: ReturnType<typeof setTimeout> | undefined;

	const pumpOutbox = () => {
		if (outboxTimer) clearTimeout(outboxTimer);
		outboxTimer = undefined;
		while (outbox.length > 0 && !starting) {
			if (runActive) {
				outbox.shift()?.(); // steers into the active run
				continue;
			}
			if (ctxRef && !ctxRef.isIdle()) {
				outboxTimer = setTimeout(pumpOutbox, 500);
				return;
			}
			outbox.shift()?.();
			starting = setTimeout(() => {
				starting = undefined;
				pumpOutbox();
			}, 5000);
		}
	};

	const deliver = (send: () => void) => {
		outbox.push(send);
		pumpOutbox();
	};

	const clearOutbox = () => {
		outbox.length = 0;
		if (outboxTimer) clearTimeout(outboxTimer);
		if (starting) clearTimeout(starting);
		outboxTimer = starting = undefined;
	};

	// --- inbound Discord messages ----------------------------------------------

	/** Save files to the inbox. Pi gets their paths, and images inline. */
	const download = async (files: IncomingFile[], id: string) => {
		const lines: string[] = [];
		const images: ImageContent[] = [];
		for (const file of files) {
			const response = await fetch(file.url);
			if (!response.ok) continue;
			const data = Buffer.from(await response.arrayBuffer());
			mkdirSync(INBOX_DIR, { recursive: true });
			const path = join(INBOX_DIR, `${id}-${basename(file.name).replace(/[^\w.-]/g, "_")}`);
			writeFileSync(path, data);
			lines.push(`[attachment: ${path}]`);
			const mimeType = file.contentType?.split(";")[0];
			if (mimeType?.startsWith("image/")) images.push({ type: "image", data: data.toString("base64"), mimeType });
		}
		return { lines, images };
	};

	const sendToPi = (lines: string[], images: ImageContent[]) => {
		const body = `${PREFIX} ${lines.join("\n")}`;
		startTyping();
		// Like pressing Enter in the TUI: starts a run when idle, steers when busy.
		deliver(() =>
			pi.sendUserMessage(images.length > 0 ? [{ type: "text", text: body }, ...images] : body, { deliverAs: "steer" }),
		);
	};

	const onDiscordMessage = async (message: Message, userId: string) => {
		if (message.author.id !== userId || message.guildId) return;
		const ctx = ctxRef;
		if (!ctx) return;
		const text = message.content.trim();

		if (/^!(stop|abort)$/i.test(text)) {
			ctx.abort();
			await message.react("⏹️").catch(() => {});
			return;
		}

		if (/^\.\/\S/.test(text)) {
			await runCommand(text.slice(1), message, ctx);
			return;
		}

		const lines = text ? [text] : [];
		if (message.reference?.type === MessageReferenceType.Default && message.reference.messageId) {
			const quoted = await message.fetchReference().catch(() => undefined);
			if (quoted) lines.unshift(describeReply(quoted, quoted.author.id === message.client.user.id));
		}
		const files = [...message.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType }));
		const saved = await download(files, message.id);
		lines.push(...saved.lines);
		if (lines.length === 0) return;
		sendToPi(lines, saved.images);
	};

	// --- /yo and "Send to pi" ------------------------------------------------------

	// Messages picked with "Send to pi", waiting for their modal.
	const shares = new Map<string, { lines: string[]; files: IncomingFile[] }>();

	const onInteraction = async (interaction: Interaction, userId: string) => {
		if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand() && !interaction.isModalSubmit()) {
			return;
		}
		if (interaction.user.id !== userId) {
			await interaction.reply({ content: "This pi only takes messages from its owner.", flags: MessageFlags.Ephemeral });
			return;
		}
		const inDm = interaction.channelId === dm?.id;
		const here = `https://discord.com/channels/${interaction.guildId ?? "@me"}/${interaction.channelId}`;
		const place = interaction.guildId
			? `server ${interaction.guildId}, channel ${interaction.channelId}`
			: inDm
				? "our DM"
				: `a DM or group DM, channel ${interaction.channelId}`;

		if (interaction.isChatInputCommand()) {
			if (interaction.commandName === YO_COMMAND) await interaction.showModal(shareModal(YO_COMMAND, "Message pi", "Message"));
			return;
		}

		if (interaction.isMessageContextMenuCommand()) {
			if (interaction.commandName !== SHARE_COMMAND) return;
			const target = interaction.targetMessage as Message | APIMessage;
			const customId = `${SHARE_PREFIX}${interaction.id}`;
			shares.set(customId, describeShared(target, `${place}: ${here}/${target.id}`, userId, interaction.client.user.id));
			setTimeout(() => shares.delete(customId), SHARE_TTL_MS).unref();
			await interaction.showModal(shareModal(customId, "Send to pi", "Note (optional)"));
			return;
		}

		const share =
			interaction.customId === YO_COMMAND
				? { lines: inDm ? [] : [`(sent with /yo from ${place}: ${here})`], files: [] }
				: shares.get(interaction.customId);
		shares.delete(interaction.customId);
		if (!share) {
			await interaction.reply({ content: "That took too long. Try again.", flags: MessageFlags.Ephemeral });
			return;
		}
		const text = interaction.fields.getTextInputValue(MODAL_TEXT).trim();
		const uploads = [...(interaction.fields.getUploadedFiles(MODAL_FILES)?.values() ?? [])];
		const files = [...share.files, ...uploads.map((a) => ({ url: a.url, name: a.name, contentType: a.contentType }))];
		const lines = [...share.lines, ...(text ? [text] : [])];
		if (!text && files.length === 0 && interaction.customId === YO_COMMAND) {
			await interaction.reply({ content: "Nothing to send.", flags: MessageFlags.Ephemeral });
			return;
		}
		// Reply within Discord's 3 seconds; downloads can take longer.
		await interaction.reply({
			content: inDm || !dm ? "-# Sent to pi" : `-# Sent to pi · [replies in your DM](https://discord.com/channels/@me/${dm.id})`,
			flags: MessageFlags.Ephemeral,
		});
		const saved = await download(files, interaction.id);
		sendToPi([...lines, ...saved.lines], saved.images);
	};

	// --- connection lifecycle ----------------------------------------------------

	const onLockChange = () => {
		if (client && !ownsLock()) {
			void disconnect({ release: false, tools: true });
			ctxRef?.ui.notify("Discord DM was taken over by another pi session", "warning");
		}
	};

	const connect = async (ctx: ExtensionContext) => {
		if (client) return;
		if (connecting) return connecting;
		connecting = (async () => {
			const { token, userId } = loadConfig();
			if (!token || !userId) throw new Error("missing bot token or user id; run /discord setup");

			const next = new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
			const ready = new Promise<void>((res) => next.once(Events.ClientReady, () => res()));
			next.on(Events.MessageCreate, (message) => {
				onDiscordMessage(message, userId).catch((err) =>
					ctxRef?.ui.notify(`discord: ${(err as Error).message}`, "error"),
				);
			});
			next.on(Events.InteractionCreate, (interaction) => {
				onInteraction(interaction, userId).catch((err) =>
					ctxRef?.ui.notify(`discord: ${(err as Error).message}`, "error"),
				);
			});
			next.on(Events.Error, (err) => ctxRef?.ui.notify(`discord: ${err.message}`, "error"));

			try {
				await next.login(token);
				await ready;
				const user = await next.users.fetch(userId);
				dm = await user.createDM();
				userInstallable = await registerCommands(next).catch((err) => {
					ctx.ui.notify(`discord: couldn't register /yo: ${(err as Error).message}`, "warning");
					return false;
				});
				client = next;
				writeLock();
				watchFile(LOCK_FILE, { interval: 1000 }, onLockChange);
				setToolActive(true);
				ctx.ui.setStatus("discord", `discord: @${user.username}`);
			} catch (err) {
				await next.destroy().catch(() => {});
				throw err;
			}
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	};

	const disconnect = async (options: { release: boolean; tools: boolean }) => {
		unwatchFile(LOCK_FILE, onLockChange);
		if (armed) finishRun();
		stopTyping();
		await queue.catch(() => {});
		const current = client;
		client = undefined;
		dm = undefined;
		await current?.destroy().catch(() => {});
		if (options.release) releaseLock();
		if (options.tools) setToolActive(false);
		ctxRef?.ui.setStatus("discord", undefined);
	};

	const enabledInSession = (ctx: ExtensionContext): boolean => {
		const entries = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
		const last = entries.at(-1) as { data?: { enabled?: boolean } } | undefined;
		return last?.data?.enabled === true;
	};

	const tryConnect = (ctx: ExtensionContext) =>
		connect(ctx).catch((err) => {
			setToolActive(false);
			ctx.ui.notify(`discord: ${(err as Error).message}`, "error");
		});

	// --- registration --------------------------------------------------------------

	pi.registerFlag("discord", { description: "Connect this session to the Discord DM", type: "boolean" });

	pi.registerTool({
		name: TOOL_NAME,
		label: "Discord files",
		description:
			"Upload local files to the user's Discord DM as attachments, with an optional caption. Use only for files; ordinary replies are forwarded automatically.",
		promptSnippet: "Upload local files to the user's Discord DM",
		promptGuidelines: [
			`User messages beginning with ${PREFIX} were sent from the user's Discord DM. Your assistant text while answering them is forwarded to that DM automatically, so reply naturally, like texting. Don't use a tool to send text.`,
			`If a reply to a ${PREFIX} message needs no Discord message, make that text exactly [silent].`,
			`${PREFIX} messages "sent with /yo" or "sharing" a message came from another Discord channel, named by server and channel ID. Your text replies still go to the DM. This extension can't read or post in that channel, but you might: before saying you can't, check AGENTS.md and your notes for access to that server, such as another bot.`,
			`Use ${TOOL_NAME} to send files such as screenshots, images, logs or documents to the Discord DM. Discord renders Markdown but not tables.`,
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "File path, absolute or relative to the working directory" }), {
				minItems: 1,
				maxItems: 10,
			}),
			caption: Type.Optional(Type.String({ description: "Optional message text sent with the files" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!dm) throw new Error("Discord is not connected");
			const files = params.paths.map((path) => expandPath(path, ctx.cwd));
			for (const file of files) {
				const stat = statSync(file);
				if (!stat.isFile()) throw new Error(`${file} is not a file`);
				if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`${file} is larger than 10 MB`);
			}
			await post(params.caption ?? "", files);
			return {
				content: [{ type: "text", text: `Sent ${files.length} file(s) to Discord.` }],
				details: { files },
			};
		},
	});

	pi.registerCommand("discord", {
		description: "Discord DM bridge: /discord [on|off|status|setup]",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const sub = args.trim().toLowerCase() || "on";

			if (sub === "setup") {
				const current = loadConfig();
				const token = (await ctx.ui.input("Discord bot token", current.token ? "(keep current)" : ""))?.trim();
				const userId = (await ctx.ui.input("Your Discord user ID", current.userId ?? ""))?.trim();
				saveConfig({ token: token || current.token, userId: userId || current.userId });
				ctx.ui.notify(`Saved ${CONFIG_FILE}`, "info");
				if (client) await disconnect({ release: false, tools: false });
			}

			if (sub === "on" || sub === "setup") {
				const holder = otherLockHolder();
				if (
					holder &&
					!(await ctx.ui.confirm("Discord DM in use", `pi process ${holder} owns the Discord DM. Take it over?`))
				) {
					return;
				}
				try {
					await connect(ctx);
					pi.appendEntry(ENTRY_TYPE, { enabled: true });
					ctx.ui.notify(
						userInstallable
							? "Discord DM connected"
							: "Discord DM connected. Turn on User Install for the bot to use /yo in other servers",
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`discord: ${(err as Error).message}`, "error");
				}
				return;
			}

			if (sub === "off") {
				await disconnect({ release: true, tools: true });
				pi.appendEntry(ENTRY_TYPE, { enabled: false });
				ctx.ui.notify("Discord DM disconnected", "info");
				return;
			}

			if (sub === `${INTERNAL_PREFIX}new`) {
				await ctx.newSession();
				return;
			}
			if (sub === `${INTERNAL_PREFIX}reload`) {
				await ctx.reload();
				return;
			}

			if (sub === "status") {
				const holder = otherLockHolder();
				const state = client
					? `connected (${client.user?.tag})${armed ? ", replying to Discord" : ""}${userInstallable ? "" : ", /yo only where the bot is"}`
					: holder
						? `owned by pi process ${holder}`
						: "disconnected";
				ctx.ui.notify(`Discord: ${state}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /discord [on|off|status|setup]", "warning");
		},
	});

	// --- pi events --------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		// Reconnect after /reload, /new or /resume in the owning process, when the
		// session was left connected, or when started with --discord.
		const wanted = pi.getFlag("discord") === true || ownsLock() || enabledInSession(ctx);
		const holder = otherLockHolder();
		if (!wanted || holder) {
			setToolActive(false);
			if (wanted && holder) ctx.ui.notify(`Discord DM is owned by pi process ${holder}; /discord to take over`, "info");
			return;
		}
		void tryConnect(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		clearOutbox();
		await disconnect({ release: event.reason === "quit", tools: false });
	});

	pi.on("message_start", (event, ctx) => {
		ctxRef = ctx;
		if (event.message.role !== "user") return;
		const text = textOf(event.message.content);
		const fromDiscord = text.startsWith(PREFIX) || armNextUser;
		armNextUser = false;
		if (fromDiscord) {
			if (!dm) return;
			if (!armed) resetRun();
			armed = true;
			return;
		}
		const wake = extensionInputs.findIndex((input) => text.startsWith(input));
		if (wake !== -1) {
			// Another extension woke the agent: behave like a custom message.
			extensionInputs.splice(wake, 1);
			return;
		}
		// A TUI or RPC prompt took over the conversation.
		localRun = true;
		if (armed) finishRun();
	});

	pi.on("input", (event) => {
		if (event.source !== "extension" || event.text.startsWith(PREFIX) || !event.text.trim()) return;
		extensionInputs.push(event.text);
		// Inputs another handler swallowed never arrive; don't let them pile up.
		if (extensionInputs.length > 20) extensionInputs.shift();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		const text = textOf(message.content).trim();
		if (!armed) {
			// Autonomous run: forward what the agent chose to say, nothing else.
			if (runActive && !localRun && dm && !isSilent(text)) void post(text);
			return;
		}
		if (!isSilent(text)) void post(text);
		if (message.stopReason === "error") void post(`⚠️ ${message.errorMessage ?? "error"}`);
		else if (message.stopReason === "aborted") void post("⏹️ aborted");
	});

	pi.on("tool_execution_start", (event) => {
		if (!armed) return;
		tools.push({ id: event.toolCallId, text: describeTool(event.toolName, event.args), state: "running" });
		bumpStatus();
	});

	pi.on("tool_execution_end", (event) => {
		const tool = tools.find((t) => t.id === event.toolCallId);
		if (!armed || !tool) return;
		tool.state = event.isError ? "error" : "done";
		bumpStatus();
	});

	// Typing shows for every run while connected; it never notifies.
	pi.on("agent_start", () => {
		runActive = true;
		if (starting) clearTimeout(starting);
		starting = undefined;
		startTyping();
		pumpOutbox();
	});

	pi.on("agent_settled", () => {
		runActive = false;
		localRun = false;
		stopTyping();
		if (armed) finishRun();
	});
}
