"use client";

// 일반 채팅의 대화 목록·기록 저장과 실행. 화면(채팅 탭)과 무관하게 앱이 켜져 있는 동안 답을 계속 받도록 실행 상태는 이 모듈이 들고 있다.
// - 목록 `chats`와 대화별 `gchat:<id>`는 이 PC에만 저장한다 (동기화 없음). 질문 전송·답 완료·중지·오류 때마다 저장하고, 스트리밍 조각마다 저장하지는 않는다.
// - 맥락은 CLI 세션 재개가 기본이다. 서비스를 바꿨거나 세션이 없으면 이전 대화를 글로 다시 보낸다 (chat-context.ts).
// - 웹 검색을 열어 봤거나 첨부가 있던 턴의 메모리 학습 태그는 저장하지 않는다 (웹 페이지·문서 속 지시로 메모리가 오염되는 것을 막는다).

import { useCallback, useSyncExternalStore } from "react";
import { runChat, type ChatRun } from "./chat-backend";
import { buildAttachmentBlocks, buildUserPrompt, classifyFile, decodeText, extractPdfText, isScannedPdf, limitAttachmentTexts, SCANNED_PDF_MESSAGE, type AttachmentRecord } from "./chat-attach";
import { buildPrompt } from "./chat-context";
import {
  addSession,
  fallbackNote,
  isSessionLostError,
  missingCliGuide,
  needsRetry,
  newChatMeta,
  normalizeMessage,
  normalizeMeta,
  planSend,
  skipLearning,
  sortChats,
  titleFrom,
  toTurns,
  DEFAULT_CHAT_TITLE,
  type ChatMeta,
  type GeneralMessage,
} from "./chat-core";
import { DEFAULT_CHAT_MODEL, parseChatModel } from "./chat-models";
import type { ChatProgress, ChatResult } from "./chat-parse";
import { desktop, errorMessage } from "./desktop";
import { prepareImage } from "./image-attach";
import { activeMemories, normalizeMemory } from "./memory-merge";
import { buildChatMemoryPrompt, CATEGORY_LABELS, extractLearned } from "./memory-prompt";
import { getStored, newId, removeStored, setStored, useStoredState } from "./storage";
import { playChatDoneSound } from "./notify-sound";
import { learnIntoStore } from "./store";
import type { Memory } from "./types";

const CHATS_KEY = "chats";
const messagesKey = (chatId: string) => `gchat:${chatId}`;
const EMPTY_LIST: unknown[] = [];

// ── 저장된 값 읽기 ──

function readChats(): ChatMeta[] {
  const raw = getStored<unknown[]>(CHATS_KEY, EMPTY_LIST);
  return sortChats((Array.isArray(raw) ? raw : []).map(normalizeMeta).filter((m): m is ChatMeta => !!m));
}

function readMessages(chatId: string): GeneralMessage[] {
  const raw = getStored<unknown[]>(messagesKey(chatId), EMPTY_LIST);
  return (Array.isArray(raw) ? raw : []).map(normalizeMessage).filter((m): m is GeneralMessage => !!m);
}

function writeChats(list: ChatMeta[]) {
  setStored(CHATS_KEY, list);
}

function writeMessages(chatId: string, messages: GeneralMessage[]) {
  setStored(messagesKey(chatId), messages);
}

function patchMeta(chatId: string, change: (meta: ChatMeta) => ChatMeta) {
  const list = readChats();
  if (!list.some((c) => c.id === chatId)) return;
  writeChats(list.map((c) => (c.id === chatId ? change(c) : c)));
}

/** 대화 목록 (최근 대화가 위) */
export function useChats(): ChatMeta[] {
  const [raw] = useStoredState<unknown[]>(CHATS_KEY, EMPTY_LIST);
  return sortChats((Array.isArray(raw) ? raw : []).map(normalizeMeta).filter((m): m is ChatMeta => !!m));
}

/** 한 대화의 메시지 (id가 없으면 빈 목록) */
export function useChatMessages(chatId: string | null): GeneralMessage[] {
  const [raw] = useStoredState<unknown[]>(messagesKey(chatId ?? "none"), EMPTY_LIST);
  return chatId && Array.isArray(raw) ? raw.map(normalizeMessage).filter((m): m is GeneralMessage => !!m) : [];
}

// ── 실행 상태 (화면을 옮겨도 이어진다) ──

interface Runtime {
  progress: ChatProgress | null;
  run: ChatRun | null;
}

const runtimes = new Map<string, Runtime>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;
let selectedId: string | null = null;

function emit() {
  snapshotVersion++;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export interface ChatRuntimeView {
  running: boolean;
  progress: ChatProgress | null;
}

const IDLE: ChatRuntimeView = { running: false, progress: null };
const viewCache = new Map<string, { version: number; view: ChatRuntimeView }>();

/** 지금 이 대화가 답을 받는 중인지와 지금까지 받은 글·활동 */
export function useChatRuntime(chatId: string | null): ChatRuntimeView {
  const get = useCallback((): ChatRuntimeView => {
    if (!chatId) return IDLE;
    const rt = runtimes.get(chatId);
    if (!rt) return IDLE;
    const cached = viewCache.get(chatId);
    if (cached && cached.version === snapshotVersion) return cached.view;
    const view = { running: true, progress: rt.progress };
    viewCache.set(chatId, { version: snapshotVersion, view });
    return view;
  }, [chatId]);
  return useSyncExternalStore(subscribe, get, () => IDLE);
}

/** 어느 대화든 답을 받는 중인 대화 id 목록 (목록에 표시) */
export function useRunningChats(): string[] {
  const get = useCallback(() => [...runtimes.keys()].sort().join(","), []);
  return useSyncExternalStore(subscribe, get, () => "").split(",").filter(Boolean);
}

export function useSelectedChatId(): string | null {
  return useSyncExternalStore(subscribe, () => selectedId, () => null);
}

export function selectChat(id: string | null) {
  selectedId = id;
  emit();
}

// ── 대화 관리 ──

export function createChat(model?: string): string {
  const id = newId();
  const previous = readChats()[0];
  writeChats([newChatMeta(id, new Date().toISOString(), model ?? previous?.model ?? DEFAULT_CHAT_MODEL), ...readChats()]);
  writeMessages(id, []);
  selectChat(id);
  return id;
}

export function renameChat(chatId: string, title: string) {
  const next = title.trim();
  if (next) patchMeta(chatId, (c) => ({ ...c, title: next }));
}

export function setChatModel(chatId: string, model: string) {
  patchMeta(chatId, (c) => ({ ...c, model }));
}

export function setChatWeb(chatId: string, web: boolean) {
  patchMeta(chatId, (c) => ({ ...c, web }));
}

/** "새 세션으로 이어 가기": 이어 가던 CLI 세션을 놓고, 다음 질문부터 최근 대화를 글로 다시 전달해 새 세션을 시작한다 */
export function startFreshSession(chatId: string) {
  patchMeta(chatId, (c) => ({ ...c, session: null, contextTokens: undefined }));
}

export function cancelChat(chatId: string) {
  runtimes.get(chatId)?.run?.cancel();
}

export async function deleteChat(chatId: string) {
  cancelChat(chatId);
  const meta = readChats().find((c) => c.id === chatId);
  await desktop.chatDeleteFiles(chatId, meta?.sessions ?? []).catch((e) => console.error("[chat] 첨부·세션 파일 정리 실패", e));
  removeStored(messagesKey(chatId));
  writeChats(readChats().filter((c) => c.id !== chatId));
  if (selectedId === chatId) selectChat(null);
}

export async function deleteAllChats() {
  const chats = readChats();
  chats.forEach((c) => cancelChat(c.id));
  await desktop.chatDeleteFiles(null, chats.flatMap((c) => c.sessions ?? [])).catch((e) => console.error("[chat] 첨부·세션 파일 정리 실패", e));
  chats.forEach((c) => removeStored(messagesKey(c.id)));
  writeChats([]);
  selectChat(null);
}

// ── 첨부 준비 ──

/** 보내기 전의 첨부: 기록용 정보와, 이미지는 저장된 파일 경로, 글·PDF는 뽑아 낸 글 */
export interface DraftAttachment {
  record: AttachmentRecord;
  text?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 파일 하나를 첨부 가능한 형태로 바꾸고 채팅 파일 폴더에 저장한다. 실패하면 사용자에게 보여 줄 문장으로 던진다 */
export async function prepareAttachment(chatId: string, file: File): Promise<DraftAttachment> {
  const kind = classifyFile(file.name, file.type);
  if (!kind) throw new Error(`${file.name}: 첨부할 수 없는 형식입니다.`);
  const id = newId();
  if (kind === "image") {
    const image = await prepareImage(file);
    const ext = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
    const path = await desktop.chatAttachSave(chatId, `${id}.${ext}`, image.data);
    return { record: { id, kind, name: file.name || image.name, size: file.size, preview: image.preview, path } };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  if (kind === "pdf") {
    const extracted = await extractPdfText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (isScannedPdf(extracted.text)) throw new Error(`${file.name}: ${SCANNED_PDF_MESSAGE}`);
    text = extracted.text;
  } else {
    const decoded = decodeText(bytes);
    if (!decoded) throw new Error(`${file.name}: 텍스트 파일이 아니라 읽을 수 없습니다.`);
    text = decoded.text;
  }
  const path = await desktop.chatAttachSave(chatId, `${id}.txt`, toBase64(new TextEncoder().encode(text)));
  return { record: { id, kind, name: file.name, size: file.size, chars: text.length, path }, text };
}

/** 저장해 둔 첨부를 다시 보낼 수 있게 되살린다 (앱이 꺼져 끊긴 질문을 "다시 보내기" 할 때) */
async function restoreAttachments(chatId: string, records: AttachmentRecord[] | undefined): Promise<DraftAttachment[]> {
  const out: DraftAttachment[] = [];
  for (const record of records ?? []) {
    if (record.kind === "image") out.push({ record });
    else out.push({ record, text: await desktop.chatAttachRead(chatId, `${record.id}.txt`).catch(() => "") });
  }
  return out;
}

// ── 질문 보내기 ──

export interface Draft {
  text: string;
  attachments: DraftAttachment[];
}

const TIMEOUT_MESSAGE = "응답이 너무 오래 걸려 중단했습니다 (10분을 넘겼거나 3분 동안 아무 출력이 없었습니다). 질문을 나눠서 다시 시도해 보세요.";
const CONTEXT_FULL_MESSAGE = "대화가 너무 길어 더 이어 갈 수 없습니다. 아래 \"새 세션으로 이어 가기\"를 눌러 최근 대화로 이어 가세요.";

function activeMemoryList(): Memory[] {
  const raw = getStored<unknown[]>("memories", EMPTY_LIST);
  return activeMemories((Array.isArray(raw) ? raw : []).map(normalizeMemory).filter((m): m is Memory => !!m));
}

function describeFailure(result: ChatResult): string {
  if (result.timedOut) return TIMEOUT_MESSAGE;
  if (result.contextFull) return CONTEXT_FULL_MESSAGE;
  return result.error ?? "응답을 받지 못했습니다.";
}

/** 새 질문을 보낸다 (메시지에 저장하고 실행). 이미 이 대화가 실행 중이면 무시한다 */
export async function sendMessage(chatId: string, draft: Draft): Promise<void> {
  const meta = readChats().find((c) => c.id === chatId);
  if (!meta || runtimes.has(chatId)) return;
  const text = draft.text.trim();
  if (!text && draft.attachments.length === 0) return;
  const parsed = parseChatModel(meta.model) ?? { provider: "claude" as const, model: "sonnet" };
  const userMessage: GeneralMessage = {
    id: newId(),
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
    model: meta.model,
    provider: parsed.provider,
    attachments: draft.attachments.length ? draft.attachments.map((a) => a.record) : undefined,
  };
  const history = readMessages(chatId);
  // 질문은 보내자마자 저장한다 (답을 받는 도중 앱이 꺼져도 질문은 남는다)
  writeMessages(chatId, [...history, userMessage]);
  patchMeta(chatId, (c) => ({ ...c, count: history.length + 1, updatedAt: userMessage.createdAt, title: c.title === DEFAULT_CHAT_TITLE && history.length === 0 && text ? titleFrom(text) : c.title }));
  await runTurn(chatId, userMessage, draft.attachments, history);
}

/** 답을 받지 못한 마지막 질문을 다시 보낸다 */
export async function retryLast(chatId: string): Promise<void> {
  if (runtimes.has(chatId)) return;
  const messages = readMessages(chatId);
  if (!needsRetry(messages)) return;
  const last = messages[messages.length - 1];
  const attachments = await restoreAttachments(chatId, last.attachments);
  await runTurn(chatId, last, attachments, messages.slice(0, -1));
}

async function runTurn(chatId: string, userMessage: GeneralMessage, attachments: DraftAttachment[], history: GeneralMessage[]) {
  const meta = readChats().find((c) => c.id === chatId);
  if (!meta) return;
  const parsed = parseChatModel(meta.model) ?? { provider: "claude" as const, model: "sonnet" };
  const web = meta.web;
  const runtime: Runtime = { progress: { text: "", activity: [] }, run: null };
  runtimes.set(chatId, runtime);
  emit();

  // 글 첨부는 합계 상한 안으로 맞춰 질문 앞에 붙인다
  const limited = limitAttachmentTexts(attachments.filter((a) => a.text !== undefined).map((a) => ({ name: a.record.name, text: a.text ?? "" })));
  const withBlocks = buildUserPrompt(userMessage.content, buildAttachmentBlocks(limited.items));
  const images = attachments.filter((a) => a.record.kind === "image" && a.record.path).map((a) => a.record.path as string);
  const turns = toTurns(history);
  const system = buildChatMemoryPrompt(activeMemoryList(), { web });

  let result: ChatResult | null = null;
  let failure: string | null = null;
  let note: string | undefined;
  let plan = planSend(meta, parsed.provider, turns.length > 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    let prompt = withBlocks;
    if (plan.fallback) {
      const built = buildPrompt(turns, withBlocks);
      prompt = built.text;
      note = fallbackNote(built.omitted, turns.length);
    }
    try {
      const run = runChat({ provider: parsed.provider, model: parsed.model, system, prompt, images, web, session: plan.resume }, (progress) => {
        runtime.progress = progress;
        emit();
      });
      runtime.run = run;
      result = await run.result;
    } catch (error) {
      failure = (error instanceof Error ? error.message : String(error)) === "CLI_NOT_FOUND" ? missingCliGuide(parsed.provider) : errorMessage(error);
      result = null;
      break;
    }
    // 이어 갈 세션을 찾지 못했으면 한 번만 세션 없이 이전 대화를 글로 보내 다시 시도한다
    if (attempt === 0 && plan.resume && result.isError && !result.text && !result.cancelled && isSessionLostError(result.error)) {
      plan = { fallback: turns.length > 0 };
      runtime.progress = { text: "", activity: [] };
      continue;
    }
    break;
  }

  const now = new Date().toISOString();
  const assistant: GeneralMessage = { id: newId(), role: "assistant", content: "", createdAt: now, model: meta.model, provider: parsed.provider };
  if (failure !== null || !result) {
    assistant.content = failure ?? "응답을 받지 못했습니다.";
    assistant.error = true;
    assistant.status = "error";
  } else if (result.isError) {
    assistant.content = describeFailure(result);
    assistant.error = true;
    assistant.status = "error";
    assistant.contextFull = result.contextFull;
    assistant.activity = result.activity.length ? result.activity : undefined;
  } else {
    // 학습 태그는 화면에서 숨기고, 웹을 열어 봤거나 첨부가 있던 턴이 아닐 때만 공통 메모리에 저장한다
    const { text: visible, learned } = extractLearned(result.text);
    const notes: string[] = [];
    if (learned.length) {
      if (skipLearning(result.activity, attachments.length)) {
        notes.push("웹 검색·첨부가 쓰인 대화라 메모리에는 저장하지 않았습니다.");
      } else {
        const common = learned.filter((l) => l.scope !== "project");
        if (common.length && learnIntoStore(common) > 0) notes.push(`메모리에 반영: ${common.map((l) => `${CATEGORY_LABELS[l.category]} · ${l.title}`).join(", ")}`);
      }
    }
    assistant.content = visible || (result.cancelled ? "" : "(응답 없음)");
    assistant.activity = result.activity.length ? result.activity : undefined;
    assistant.status = result.cancelled ? "stopped" : "done";
    assistant.notes = notes.length ? notes : undefined;
  }
  // 끝났다는 알림음 (오류로 끝난 경우 포함, 사용자가 직접 멈춘 경우는 제외)
  playChatDoneSound(assistant.status === "stopped" ? "cancelled" : assistant.status === "error" ? "error" : "done", "chat");

  // 첨부가 잘렸는지, 세션 없이 이어 보냈는지를 질문 메시지에 반영해 저장한다
  const truncatedNames = new Set(limited.items.filter((i) => i.truncated).map((i) => i.name));
  const updatedUser: GeneralMessage = {
    ...userMessage,
    note,
    attachments: userMessage.attachments?.map((a) => (truncatedNames.has(a.name) ? { ...a, truncated: true } : a)),
  };
  const saved = readMessages(chatId);
  const base = saved.some((m) => m.id === userMessage.id) ? saved.map((m) => (m.id === userMessage.id ? updatedUser : m)) : [...saved, updatedUser];
  writeMessages(chatId, [...base, assistant]);
  patchMeta(chatId, (c) => {
    const ref = result?.sessionId ? { provider: parsed.provider, id: result.sessionId } : null;
    return {
      ...c,
      count: base.length + 1,
      updatedAt: now,
      session: ref ?? c.session,
      sessions: ref ? addSession(c.sessions, ref) : c.sessions,
      contextTokens: result?.usage?.contextTokens ?? c.contextTokens,
    };
  });
  runtimes.delete(chatId);
  viewCache.delete(chatId);
  emit();
}
