import {
  Bell,
  Copy,
  FolderOpen,
  GitBranch,
  GitFork,
  LayoutGrid,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Search,
  SendHorizontal,
  Server,
  Square,
  SquareTerminal,
  Trash2,
  Inbox,
} from "lucide-react";
import { useState } from "react";
import {
  AgentGlyph,
  Badge,
  BottomSheet,
  Button,
  Card,
  Chip,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  CountBadge,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSES,
  ScrollArea,
  SegmentedControl,
  Select,
  Spinner,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tile,
  TitleBar,
  Tooltip,
  toast,
} from "@/design";
import { Demo, Section } from "./Showcase";

const MODELS = [
  { value: "opus-5", label: "opus-5", hint: "anthropic · default" },
  { value: "sonnet-5", label: "sonnet-5", hint: "anthropic" },
  { value: "gpt-5.5", label: "gpt-5.5", hint: "openai" },
  { value: "tiny", label: "tiny", hint: "cheap role" },
];

export function ActionsSection() {
  const [loading, setLoading] = useState(false);
  return (
    <Section id="actions" kicker="08 · Actions" title="Buttons, chips, badges">
      <div className="grid gap-4 lg:grid-cols-2">
        <Demo label="Button variants">
          <Button variant="primary" icon={<Plus />}>
            New worktree
          </Button>
          <Button variant="secondary">Review diff</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={<Square />}>
            Stop
          </Button>
          <Button variant="sunset">Allow once</Button>
        </Demo>
        <Demo label="Sizes · loading · disabled · trailing kbd">
          <Button size="sm" variant="primary">
            Small
          </Button>
          <Button size="lg" variant="primary" icon={<Play />} trailing={<Kbd className="bg-white/20 text-white shadow-none">Ctrl ↵</Kbd>}>
            Start agent
          </Button>
          <Button
            loading={loading}
            onClick={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 1600);
            }}
          >
            {loading ? "Connecting" : "Connect"}
          </Button>
          <Button disabled>Disabled</Button>
        </Demo>
        <Demo label="IconButton (+ badge, tooltip)">
          <Tooltip content="Notifications" shortcut="Ctrl B">
            <IconButton label="Notifications" variant="secondary" badge={2}>
              <Bell />
            </IconButton>
          </Tooltip>
          <Tooltip content="Search" shortcut="Ctrl K">
            <IconButton label="Search">
              <Search />
            </IconButton>
          </Tooltip>
          <IconButton label="Send" variant="primary">
            <SendHorizontal />
          </IconButton>
          <IconButton label="Voice" variant="primary" size="lg" className="rounded-full">
            <Mic />
          </IconButton>
          <IconButton label="Stop" variant="danger" size="sm">
            <Square />
          </IconButton>
        </Demo>
        <Demo label="Chip · Badge · CountBadge · Kbd">
          <Chip icon={<GitBranch />}>feat/android-push</Chip>
          <Chip tone="accent">opus-5 · high</Chip>
          <Chip tone="needs-you" solid>
            waiting 6m
          </Chip>
          <Chip tone="review">48 tests passed</Chip>
          <Badge tone="needs-you">Question</Badge>
          <Badge tone="review">Ready to review</Badge>
          <Badge tone="accent">Plan</Badge>
          <Badge>Draft</Badge>
          <CountBadge count={2} />
          <span className="flex gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Demo>
        <Demo label="StatusPill" className="lg:col-span-2">
          {STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
          {STATUSES.slice(0, 4).map((s) => (
            <StatusPill key={`${s}-sm`} status={s} size="sm" />
          ))}
        </Demo>
      </div>
    </Section>
  );
}

export function FormsSection() {
  const [scope, setScope] = useState<"worktree" | "branch">("worktree");
  const [thinking, setThinking] = useState<"low" | "medium" | "high" | "xhigh">("high");
  const [autoStart, setAutoStart] = useState(true);
  const [prompt, setPrompt] = useState("");
  return (
    <Section id="forms" kicker="09 · Inputs" title="Fields, select, switch, segmented, tabs">
      <div className="grid gap-4 lg:grid-cols-2">
        <Tile className="flex flex-col gap-4 p-5">
          <Field label="Branch name" hint="auto">
            {(id) => <Input id={id} placeholder="feat/rate-limits" leading={<GitBranch />} />}
          </Field>
          <Field label="Search" description="Agents, sessions and commands.">
            {(id) => <Input id={id} placeholder="Search agents, run a command" leading={<Search />} trailing={<Kbd>Ctrl K</Kbd>} />}
          </Field>
          <Field label="Worktree path" error="Path already exists on forge">
            {(id) => <Input id={id} defaultValue="~/code/teleflock/.worktrees/push" invalid className="font-mono text-xs" />}
          </Field>
          <Field label="Model">{(id) => <Select id={id} options={MODELS} defaultValue="opus-5" className="w-full" />}</Field>
        </Tile>
        <Tile className="flex flex-col gap-4 p-5">
          <Field label="Prompt">
            {(id) => (
              <Textarea
                id={id}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask omp anything… / for commands, @ for files"
                footer={
                  <>
                    <IconButton label="Attach" size="sm">
                      <Paperclip />
                    </IconButton>
                    <Chip tone="accent" className="h-6">
                      plan
                    </Chip>
                    <IconButton label="Send" size="sm" variant="primary" className="ml-auto" disabled={!prompt.trim()}>
                      <SendHorizontal />
                    </IconButton>
                  </>
                }
              />
            )}
          </Field>
          <SegmentedControl
            aria-label="Create from"
            value={scope}
            onValueChange={setScope}
            fill
            options={[
              { value: "worktree", label: "New worktree", icon: <GitFork /> },
              { value: "branch", label: "Existing branch", icon: <GitBranch /> },
            ]}
          />
          <SegmentedControl
            aria-label="Thinking level"
            size="sm"
            value={thinking}
            onValueChange={setThinking}
            options={(["low", "medium", "high", "xhigh"] as const).map((v) => ({ value: v, label: v }))}
          />
          <label className="flex items-center gap-3 rounded-lg well p-3 text-sm font-bold">
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            Start omp in the new pane
            <span className="ml-auto text-xs font-semibold text-mute">{autoStart ? "on" : "off"}</span>
          </label>
        </Tile>
        <Tile className="p-5 lg:col-span-2">
          <Tabs defaultValue="transcript">
            <TabsList>
              <TabsTrigger value="transcript" badge={<CountBadge count={2} />}>
                <MessageSquare /> Transcript
              </TabsTrigger>
              <TabsTrigger value="terminal">
                <SquareTerminal /> Terminal
              </TabsTrigger>
              <TabsTrigger value="files">
                <FolderOpen /> Files
              </TabsTrigger>
            </TabsList>
            <TabsContent value="transcript" className="pt-4 text-sm text-mute">
              Underline tabs: the indicator glides between triggers.
            </TabsContent>
            <TabsContent value="terminal" className="pt-4 text-sm text-mute">
              The terminal tab content.
            </TabsContent>
            <TabsContent value="files" className="pt-4 text-sm text-mute">
              Files changed in this session.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="w5:p2" variant="pill" className="mt-5">
            <TabsList className="inline-flex">
              {["w5:p1", "w5:p2", "w5:p3"].map((v) => (
                <TabsTrigger key={v} value={v} className="font-mono">
                  {v}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Tile>
      </div>
    </Section>
  );
}

export function OverlaysSection() {
  const [sheet, setSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  return (
    <Section id="overlays" kicker="10 · Overlays" title="Dialog, sheet, popover, menus, palette, toasts">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Demo label="Dialog (backdrop blur)">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary" icon={<GitFork />}>
                New worktree…
              </Button>
            </DialogTrigger>
            <DialogContent
              icon={<GitFork />}
              title="New worktree"
              description="teleflock · forge · from main"
              footer={
                <>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="primary" trailing={<Kbd className="bg-white/20 text-white shadow-none">↵</Kbd>}>
                      Create &amp; start
                    </Button>
                  </DialogClose>
                </>
              }
            >
              <div className="flex flex-col gap-3">
                <Field label="Branch">{(id) => <Input id={id} autoFocus placeholder="feat/…" leading={<GitBranch />} />}</Field>
                <Field label="Model">{(id) => <Select id={id} options={MODELS} defaultValue="opus-5" className="w-full" />}</Field>
              </div>
            </DialogContent>
          </Dialog>
        </Demo>
        <Demo label="BottomSheet (drag handle down)">
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <BottomSheet
            open={sheet}
            onOpenChange={setSheet}
            title="Start an agent"
            description="forge · teleflock"
            footer={
              <Button variant="primary" size="lg" className="w-full" icon={<Play />} onClick={() => setSheet(false)}>
                Start omp
              </Button>
            }
          >
            <div className="flex flex-col gap-2">
              {["teleflock", "api-gateway", "marketing-site", "infra"].map((r, i) => (
                <button
                  key={r}
                  type="button"
                  className="flex items-center gap-3 rounded-lg well p-3 text-left pressable focus-ring data-[on=true]:bg-accent/12 data-[on=true]:shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.6)]"
                  data-on={i === 0}
                >
                  <AgentGlyph name={r} size={34} />
                  <span className="flex-1">
                    <b className="block text-sm">{r}</b>
                    <span className="font-mono text-2xs text-mute">~/code/{r}</span>
                  </span>
                </button>
              ))}
            </div>
          </BottomSheet>
        </Demo>
        <Demo label="Popover">
          <Popover>
            <PopoverTrigger asChild>
              <Button icon={<Server />}>forge · 14 ms</Button>
            </PopoverTrigger>
            <PopoverContent className="w-72">
              <div className="flex items-center gap-3">
                <AgentGlyph name="forge" size={34} status="done" />
                <div>
                  <b className="block font-display text-md">forge</b>
                  <span className="text-xs text-mute">Tailscale · 100.86.14.7 · herdr 0.9.2</span>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" className="flex-1">
                  Switch host
                </Button>
                <Button size="sm" variant="ghost">
                  Disconnect
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </Demo>
        <Demo label="DropdownMenu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="More" variant="secondary">
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Session</DropdownMenuLabel>
              <DropdownMenuItem icon={<Pencil />} shortcut="F2">
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem icon={<GitFork />}>Fork from here</DropdownMenuItem>
              <DropdownMenuItem icon={<Copy />} shortcut="Ctrl C">
                Copy session id
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem checked>Follow output</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Trash2 />} danger>
                Close pane
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Demo>
        <Demo label="ContextMenu (right-click / long-press)">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Card className="flex w-full cursor-context-menu items-center gap-3 p-3 select-none">
                <AgentGlyph name="kanban" size={30} status="running" />
                <span className="text-sm font-bold">Right-click this card</span>
              </Card>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel>kanban</ContextMenuLabel>
              <ContextMenuItem icon={<MessageSquare />}>Open session</ContextMenuItem>
              <ContextMenuItem icon={<SquareTerminal />} shortcut="Ctrl `">
                Open terminal
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem icon={<Square />} danger>
                Abort run
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Demo>
        <Demo label="Command palette (cmdk)">
          <Button icon={<Search />} trailing={<Kbd>Ctrl K</Kbd>} onClick={() => setPalette(true)}>
            Search
          </Button>
          <CommandDialog open={palette} onOpenChange={setPalette}>
            <CommandInput placeholder="Search agents, run a command…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Agents">
                {["kanban", "push", "reconnect"].map((n) => (
                  <CommandItem key={n} value={n} icon={<AgentGlyph name={n} size={22} />} onSelect={() => setPalette(false)}>
                    {n}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem icon={<Plus />} shortcut="Ctrl N" onSelect={() => setPalette(false)}>
                  New worktree
                </CommandItem>
                <CommandItem icon={<LayoutGrid />} shortcut="Ctrl 1" onSelect={() => setPalette(false)}>
                  Go to board
                </CommandItem>
                <CommandItem icon={<SquareTerminal />} onSelect={() => setPalette(false)}>
                  Open terminal
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </Demo>
        <Demo label="Toast" className="md:col-span-2 xl:col-span-3">
          <Button
            variant="sunset"
            onClick={() =>
              toast({
                status: "needs-you",
                title: "push needs you",
                description: "How should notifications reach your phone?",
                action: { label: "Answer", onClick: () => {} },
              })
            }
          >
            Needs-you toast
          </Button>
          <Button onClick={() => toast({ status: "review", title: "reconnect is ready to review", description: "48 tests passed · PR #142" })}>
            Review toast
          </Button>
          <Button onClick={() => toast({ status: "done", title: "docs merged", description: "#139 · +340 −12" })}>Done toast</Button>
          <Button variant="danger" onClick={() => toast({ status: "error", title: "ci failed", description: "bun install exited 1" })}>
            Error toast
          </Button>
        </Demo>
      </div>
    </Section>
  );
}

export function SurfacesSection() {
  return (
    <Section id="surfaces" kicker="11 · Surfaces" title="Tiles, scroll, empty, spinner, title bar">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(["default", "flat", "glass", "deep", "omp", "sunset"] as const).map((v) => (
          <Tile key={v} variant={v} className="flex min-h-28 flex-col justify-end p-5">
            <span className="kicker text-current opacity-70">Tile</span>
            <span className="font-display text-xl font-bold">{v}</span>
          </Tile>
        ))}
        <Tile className="p-2">
          <ScrollArea className="h-48" fade>
            <div className="flex flex-col gap-1 p-2">
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs text-ink-2 hover:bg-white/4">
                  <span className="text-mute-2">{String(i + 1).padStart(2, "0")}</span>
                  {i % 3 === 0 ? "✓ columns.test.ts" : i % 3 === 1 ? "● drag-drop.test.ts running" : "✓ persist.test.ts"}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Tile>
        <Tile className="p-0">
          <EmptyState icon={<Inbox />} title="Nothing needs you" description="When an agent asks a question or wants approval, it lands here." action={<Button size="sm">Open board</Button>} />
        </Tile>
        <Tile className="flex items-center justify-center gap-6 p-5">
          <Spinner size={14} />
          <Spinner size={22} />
          <Spinner size={34} />
        </Tile>
        <Tile className="overflow-hidden p-0 md:col-span-2 xl:col-span-3">
          <TitleBar
            subtitle={
              <>
                forge · default · <span className="text-done">●</span> Tailscale
              </>
            }
            actions={
              <IconButton label="Notifications" size="sm" badge={2}>
                <Bell />
              </IconButton>
            }
          />
          <p className="px-5 py-3 text-xs text-mute">
            TitleBar: drag region + Windows controls via the Tauri window API; controls are hidden outside Tauri (this preview) and the bar is not rendered on Android.
          </p>
        </Tile>
      </div>
    </Section>
  );
}
