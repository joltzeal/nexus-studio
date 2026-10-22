'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { Tabs as TabsPrimitive } from 'radix-ui'

const TabsOrientation = React.createContext<'horizontal' | 'vertical'>('horizontal')

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsOrientation.Provider value={orientation}>
      <TabsPrimitive.Root
        data-slot="tabs"
        orientation={orientation}
        className={cn('flex gap-2 data-horizontal:flex-col', className)}
        {...props}
      />
    </TabsOrientation.Provider>
  )
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground data-horizontal:h-8 data-vertical:h-fit data-vertical:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
        pill: 'rounded-full border border-border/60 bg-muted/70 p-1 data-horizontal:h-12',
        navigation: 'w-full gap-1 bg-transparent p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const orientation = React.useContext(TabsOrientation)
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-orientation={orientation}
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const orientation = React.useContext(TabsOrientation)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-orientation={orientation}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all data-vertical:w-full data-vertical:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent',
        'data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground',
        'after:absolute after:bg-foreground after:opacity-0 after:transition-opacity data-horizontal:after:inset-x-0 data-horizontal:after:bottom-[-5px] data-horizontal:after:h-0.5 data-vertical:after:inset-y-0 data-vertical:after:-right-1 data-vertical:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
        'group-data-[variant=pill]/tabs-list:rounded-full group-data-[variant=pill]/tabs-list:px-6 group-data-[variant=pill]/tabs-list:data-active:bg-primary group-data-[variant=pill]/tabs-list:data-active:text-primary-foreground group-data-[variant=pill]/tabs-list:data-active:shadow-none',
        'group-data-[variant=navigation]/tabs-list:h-9 group-data-[variant=navigation]/tabs-list:flex-none group-data-[variant=navigation]/tabs-list:justify-start group-data-[variant=navigation]/tabs-list:gap-2 group-data-[variant=navigation]/tabs-list:px-3 group-data-[variant=navigation]/tabs-list:text-muted-foreground group-data-[variant=navigation]/tabs-list:hover:bg-muted group-data-[variant=navigation]/tabs-list:data-active:bg-accent group-data-[variant=navigation]/tabs-list:data-active:text-primary group-data-[variant=navigation]/tabs-list:data-active:font-semibold group-data-[variant=navigation]/tabs-list:data-active:shadow-none dark:group-data-[variant=navigation]/tabs-list:data-active:border-transparent',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 text-sm outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
