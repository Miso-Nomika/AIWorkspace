"use client";

import { useState, type ComponentType } from "react";
import { whenOk, type Block } from "@/lib/home-widget-core";
import { ChartBlock } from "./ChartBlock";
import { MacroBlock } from "./MacroBlock";
import { BarBlock, ChecklistBlock, ClockBlock, LineBlock, StatBlock, TableBlock, TextBlock, type LeafProps } from "./Leaves";

/**
 * 블록 종류 → 화면 컴포넌트. 새 블록 종류를 더하려면 여기에 한 줄과
 * src/lib/home-widget-core.ts의 BLOCK_SPECS 항목(검증·생성 지침 설명·예시)을 추가한다.
 */
export const BLOCK_COMPONENTS: Record<string, ComponentType<LeafProps>> = {
  text: TextBlock,
  stat: StatBlock,
  table: TableBlock,
  line: LineBlock,
  bar: BarBlock,
  chart: ChartBlock,
  checklist: ChecklistBlock,
  clock: ClockBlock,
  macro: MacroBlock,
  row: RowBlock,
  column: ColumnBlock,
  tabs: TabsBlock,
};

/** 한 블록을 그린다 — when 조건이 맞지 않으면 아무것도 그리지 않는다 */
export function BlockView(props: LeafProps) {
  if (!whenOk(props.block.when, props.data)) return null;
  const Component = BLOCK_COMPONENTS[props.block.type];
  return Component ? <Component {...props} /> : null;
}

function Children({ blocks, base, data, onToggle }: { blocks: Block[]; base: number[]; data: unknown; onToggle: LeafProps["onToggle"] }) {
  return (
    <>
      {blocks.map((child, i) => (
        <div key={i} className="min-w-0">
          <BlockView block={child} data={data} path={[...base, i]} onToggle={onToggle} />
        </div>
      ))}
    </>
  );
}

function RowBlock({ block, data, path, onToggle }: LeafProps) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
      <Children blocks={block.children as Block[]} base={path} data={data} onToggle={onToggle} />
    </div>
  );
}

function ColumnBlock({ block, data, path, onToggle }: LeafProps) {
  return (
    <div className="flex flex-col gap-3">
      <Children blocks={block.children as Block[]} base={path} data={data} onToggle={onToggle} />
    </div>
  );
}

function TabsBlock({ block, data, path, onToggle }: LeafProps) {
  const tabs = block.tabs as { label: string; children: Block[] }[];
  const [active, setActive] = useState(0);
  const current = Math.min(active, tabs.length - 1);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1" role="tablist">
        {tabs.map((t, i) => (
          <button key={i} type="button" role="tab" aria-selected={i === current} onClick={() => setActive(i)} className={`rounded-md px-2 py-1 text-xs ${i === current ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-background"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <Children blocks={tabs[current].children} base={[...path, current]} data={data} onToggle={onToggle} />
      </div>
    </div>
  );
}
