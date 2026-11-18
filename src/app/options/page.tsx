import type { Metadata } from "next";
import { OptionsPanel } from "@/components/options/OptionsPanel";

export const metadata: Metadata = { title: "옵션 · AIWorkspace" };

export default function OptionsPage() {
  return <OptionsPanel />;
}
