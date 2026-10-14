"use client"

import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Same setup as the shadcn/ui "Sonner" component (light theme, no next-themes needed here).
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 rounded-full bg-green-500 text-white" />,
        info: <InfoIcon className="size-4 rounded-full bg-blue-500 text-white" />,
        warning: <TriangleAlertIcon className="size-4 rounded-full bg-yellow-500 text-white" />,
        error: <OctagonXIcon className="size-4 rounded-full bg-red-500 text-white" />,
        loading: <Loader2Icon className="size-4 animate-spin rounded-full bg-gray-500 text-white" />,
      }}
      style={
        {

          "--normal-bg": "#f6f6f6",
          "--normal-text": "#0a0a0a",
          "--normal-border": "#00000000",
          "--border-radius": "15px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
