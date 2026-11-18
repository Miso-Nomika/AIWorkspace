import type { Metadata } from "next";
import { MemoryManager } from "@/components/memory/MemoryManager";

export const metadata: Metadata = { title: "메모리 · AIWorkspace" };

export default function MemoryPage() {
  return <MemoryManager />;
}
