import type { Metadata } from "next";
import { GeneralChat } from "@/components/chat/GeneralChat";

export const metadata: Metadata = { title: "채팅 · AIWorkspace" };

export default function ChatPage() {
  return <GeneralChat />;
}
