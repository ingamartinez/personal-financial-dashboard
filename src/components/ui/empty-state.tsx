import * as React from "react"

import { cn } from "@/lib/utils"

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          data-slot="empty-state-icon"
          className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <div className="font-heading text-base font-medium text-foreground">
          {title}
        </div>
        {description ? (
          <p className="max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
