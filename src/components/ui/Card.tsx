interface CardProps {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Card({ title, icon, action, className = "", children }: CardProps) {
  return (
    <section className={`rounded-xl border border-border bg-surface ${className}`}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
