import { forwardRef, type ComponentProps } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  AlertCircleIcon, ArrowDown01Icon, ArrowLeft01Icon, ArrowLeftRightIcon,
  ArrowRight01Icon, ArrowUp01Icon, ArrowUpDownIcon, ArrowUpRight01Icon,
  BlocksIcon, BookMarkedIcon, Bookmark02Icon, BotIcon, CableIcon,
  Camera01Icon, CheckmarkCircle02Icon, CheckmarkCircle01Icon, Tick02Icon,
  ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon,
  ChevronsLeftIcon, ChevronsLeftRightIcon, ChevronsRightIcon,
  UnfoldMoreIcon, CircleIcon, HelpCircleIcon, ClipboardListIcon,
  Clock01Icon, ColumnsThreeCogIcon, Copy01Icon, DicesIcon,
  Download04Icon, EllipsisIcon, LinkSquare01Icon, ViewIcon,
  ViewOffSlashIcon, FingerPrintIcon, FlaskConicalIcon, FolderInputIcon,
  FolderOpenIcon, FolderAddIcon, Folder01Icon, GaugeIcon, Globe02Icon,
  DragDropVerticalIcon, HashIcon, FavouriteIcon, HistoryIcon,
  Image01Icon, ImageAdd01Icon, ImageNotFound01Icon, InformationCircleIcon,
  Key01Icon, LayoutGridIcon, LifebuoyIcon, Link04Icon, ListViewIcon,
  Task01Icon, Loading03Icon, Mail01Icon, MapPinIcon, MapPinnedIcon,
  MinusSignIcon, MoreHorizontalIcon, MoreVerticalIcon, NetworkIcon,
  Package01Icon, PackageAdd01Icon, PanelLeftCloseIcon, PanelLeftOpenIcon,
  PanelTopIcon, Attachment01Icon, PencilEdit01Icon, PlayIcon, PlusSignIcon,
  RadarIcon, RadioIcon, ArrowReloadHorizontalIcon, RepeatIcon,
  Undo02Icon, Route01Icon, FloppyDiskIcon, Search01Icon, Settings01Icon,
  ShieldAlertIcon, ShieldCheckIcon, ShoppingBag01Icon, ShoppingCart01Icon,
  SlidersHorizontalIcon, SmartPhone01Icon, SparklesIcon, StopIcon,
  StarIcon, Store01Icon, Sun01Icon, Moon02Icon, Time01Icon,
  Delete02Icon, Alert02Icon, Cancel01Icon, CancelCircleIcon,
  Unlink01Icon, Upload04Icon, UserAdd01Icon, UserIcon, UserGroupIcon,
  MagicWand01Icon,
} from '@hugeicons/core-free-icons'

type Glyph = ComponentProps<typeof HugeiconsIcon>['icon']
type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, 'icon'>

function icon(glyph: Glyph) {
  return forwardRef<SVGSVGElement, IconProps>(function Icon(props, ref) {
    return <HugeiconsIcon ref={ref} icon={glyph} size={16} strokeWidth={1.5} aria-hidden="true" {...props} />
  })
}

export const AlertCircle = icon(AlertCircleIcon)
export const ArrowDown = icon(ArrowDown01Icon)
export const ArrowLeft = icon(ArrowLeft01Icon)
export const ArrowLeftRight = icon(ArrowLeftRightIcon)
export const ArrowRight = icon(ArrowRight01Icon)
export const ArrowUp = icon(ArrowUp01Icon)
export const ArrowUpDown = icon(ArrowUpDownIcon)
export const ArrowUpRight = icon(ArrowUpRight01Icon)
export const Blocks = icon(BlocksIcon)
export const BookMarked = icon(BookMarkedIcon)
export const Bookmark = icon(Bookmark02Icon)
export const Bot = icon(BotIcon)
export const Cable = icon(CableIcon)
export const Camera = icon(Camera01Icon)
export const Check = icon(Tick02Icon)
export const CheckCircle2 = icon(CheckmarkCircle02Icon)
export const CheckIcon = icon(Tick02Icon)
export const ChevronDown = icon(ChevronDownIcon)
export const ChevronDownIconApp = icon(ChevronDownIcon)
export const ChevronLeft = icon(ChevronLeftIcon)
export const ChevronRight = icon(ChevronRightIcon)
export const ChevronUpIconApp = icon(ChevronUpIcon)
export const ChevronsLeft = icon(ChevronsLeftIcon)
export const ChevronsLeftRight = icon(ChevronsLeftRightIcon)
export const ChevronsRight = icon(ChevronsRightIcon)
export const ChevronsUpDown = icon(UnfoldMoreIcon)
export const Circle = icon(CircleIcon)
export const CircleCheck = icon(CheckmarkCircle01Icon)
export const CircleHelp = icon(HelpCircleIcon)
export const ClipboardList = icon(ClipboardListIcon)
export const Clock3 = icon(Clock01Icon)
export const Columns3 = icon(ColumnsThreeCogIcon)
export const Copy = icon(Copy01Icon)
export const Dices = icon(DicesIcon)
export const Download = icon(Download04Icon)
export const Ellipsis = icon(EllipsisIcon)
export const ExternalLink = icon(LinkSquare01Icon)
export const Eye = icon(ViewIcon)
export const EyeOff = icon(ViewOffSlashIcon)
export const Fingerprint = icon(FingerPrintIcon)
export const FlaskConical = icon(FlaskConicalIcon)
export const FolderInput = icon(FolderInputIcon)
export const FolderOpen = icon(FolderOpenIcon)
export const FolderPlus = icon(FolderAddIcon)
export const Folders = icon(Folder01Icon)
export const Gauge = icon(GaugeIcon)
export const Globe2 = icon(Globe02Icon)
export const GripVertical = icon(DragDropVerticalIcon)
export const Hash = icon(HashIcon)
export const Heart = icon(FavouriteIcon)
export const History = icon(HistoryIcon)
export const Image = icon(Image01Icon)
export const ImageIcon = icon(Image01Icon)
export const ImageOff = icon(ImageNotFound01Icon)
export const ImagePlus = icon(ImageAdd01Icon)
export const Info = icon(InformationCircleIcon)
export const KeyRound = icon(Key01Icon)
export const LayoutGrid = icon(LayoutGridIcon)
export const LifeBuoy = icon(LifebuoyIcon)
export const Link2 = icon(Link04Icon)
export const List = icon(ListViewIcon)
export const ListChecks = icon(Task01Icon)
export const Loader2 = icon(Loading03Icon)
export const LoaderCircle = icon(Loading03Icon)
export const Mail = icon(Mail01Icon)
export const MapPin = icon(MapPinIcon)
export const MapPinned = icon(MapPinnedIcon)
export const Minus = icon(MinusSignIcon)
export const MinusIconApp = icon(MinusSignIcon)
export const Monitor = icon(PanelTopIcon)
export const Moon = icon(Moon02Icon)
export const MoreHorizontal = icon(MoreHorizontalIcon)
export const MoreVertical = icon(MoreVerticalIcon)
export const Network = icon(NetworkIcon)
export const Package = icon(Package01Icon)
export const PackagePlus = icon(PackageAdd01Icon)
export const PanelLeftClose = icon(PanelLeftCloseIcon)
export const PanelLeftOpen = icon(PanelLeftOpenIcon)
export const PanelsTopLeft = icon(PanelTopIcon)
export const Paperclip = icon(Attachment01Icon)
export const Pencil = icon(PencilEdit01Icon)
export const Play = icon(PlayIcon)
export const Plus = icon(PlusSignIcon)
export const Radar = icon(RadarIcon)
export const Radio = icon(RadioIcon)
export const RefreshCw = icon(ArrowReloadHorizontalIcon)
export const Repeat = icon(RepeatIcon)
export const RotateCcw = icon(Undo02Icon)
export const Route = icon(Route01Icon)
export const Save = icon(FloppyDiskIcon)
export const ScanSearch = icon(Search01Icon)
export const Search = icon(Search01Icon)
export const Settings2 = icon(Settings01Icon)
export const ShieldAlert = icon(ShieldAlertIcon)
export const ShieldCheck = icon(ShieldCheckIcon)
export const ShoppingBag = icon(ShoppingBag01Icon)
export const ShoppingCart = icon(ShoppingCart01Icon)
export const SlidersHorizontal = icon(SlidersHorizontalIcon)
export const Smartphone = icon(SmartPhone01Icon)
export const Sparkles = icon(SparklesIcon)
export const Square = icon(StopIcon)
export const Star = icon(StarIcon)
export const Store = icon(Store01Icon)
export const Sun = icon(Sun01Icon)
export const Timer = icon(Time01Icon)
export const Trash2 = icon(Delete02Icon)
export const TriangleAlert = icon(Alert02Icon)
export const Undo2 = icon(Undo02Icon)
export const Unlink = icon(Unlink01Icon)
export const Upload = icon(Upload04Icon)
export const UserPlus = icon(UserAdd01Icon)
export const UserRound = icon(UserIcon)
export const Users = icon(UserGroupIcon)
export const Wand2 = icon(MagicWand01Icon)
export const X = icon(Cancel01Icon)
export const XCircle = icon(CancelCircleIcon)
export const XIcon = icon(Cancel01Icon)
export { ChevronDownIconApp as ChevronDownIcon, ChevronUpIconApp as ChevronUpIcon, MinusIconApp as MinusIcon }
