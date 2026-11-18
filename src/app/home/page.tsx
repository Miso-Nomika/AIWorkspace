import type { Metadata } from "next";
import { HomeView } from "@/components/home/HomeView";

export const metadata: Metadata = { title: "홈 · AIWorkspace" };

export default function HomePage() {
  return <HomeView />;
}
