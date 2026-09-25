const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

function Svg({ children, className = 'w-5 h-5', ...rest }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...base} {...rest}>
      {children}
    </svg>
  )
}

export const IconDashboard = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="8.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="5" rx="2" />
    <rect x="13.5" y="11" width="7.5" height="10" rx="2" />
    <rect x="3" y="14.5" width="7.5" height="6.5" rx="2" />
  </Svg>
)

export const IconClients = (p) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3 3 0 0 1 0 5.8" />
    <path d="M17.5 14.4A5.2 5.2 0 0 1 21 20" />
  </Svg>
)

export const IconEmployees = (p) => (
  <Svg {...p}>
    <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
    <path d="M8.5 7.5V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5v2" />
    <path d="M3 12.5h18" />
    <path d="M11 12.5h2v2h-2z" />
  </Svg>
)

export const IconInvoices = (p) => (
  <Svg {...p}>
    <path d="M5.5 3h13v18l-2.2-1.6-2.15 1.6-2.15-1.6L9.85 21 7.7 19.4 5.5 21z" />
    <path d="M9 8h6M9 12h6" />
  </Svg>
)

export const IconExpenses = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 12h.01M18 12h.01" />
  </Svg>
)

export const IconServices = (p) => (
  <Svg {...p}>
    <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" />
    <path d="M4 7.6 12 12l8-4.4M12 12v8.8" />
  </Svg>
)

export const IconReports = (p) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <rect x="5.5" y="11" width="3.6" height="6" rx="1.2" />
    <rect x="10.2" y="7" width="3.6" height="10" rx="1.2" />
    <rect x="14.9" y="4" width="3.6" height="13" rx="1.2" />
  </Svg>
)

export const IconSettings = (p) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h9M17 17h3" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="15" cy="17" r="2" />
  </Svg>
)

export const IconAssets = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="7" width="19" height="12" rx="2.5" />
    <circle cx="12" cy="13" r="3.2" />
    <path d="M8 7l1.4-2.2A1.5 1.5 0 0 1 10.6 4h2.8a1.5 1.5 0 0 1 1.2.8L16 7" />
  </Svg>
)

export const IconVendors = (p) => (
  <Svg {...p}>
    <path d="M4 9.5 5.6 5A1.6 1.6 0 0 1 7.1 4h9.8a1.6 1.6 0 0 1 1.5 1.1L20 9.5" />
    <path d="M4 9.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M9.5 13.5h5" />
  </Svg>
)

export const IconUsers = (p) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M17 4.5v5M19.5 7h-5" />
  </Svg>
)

export const IconQuote = (p) => (
  <Svg {...p}>
    <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14.5 3v4.5H19" />
    <path d="M8.5 13h7M8.5 17h4" />
  </Svg>
)

export const IconVouchers = (p) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M8 8h8M8 12h8M8 16h4" />
  </Svg>
)

export const IconTreasury = (p) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="18" height="13" rx="2.5" />
    <path d="M3 11h18" />
    <path d="M7 4.5h10" />
    <circle cx="16.5" cy="15.5" r="1.4" />
  </Svg>
)

export const IconAccounting = (p) => (
  <Svg {...p}>
    <path d="M12 3.5v17" />
    <path d="M5 7.5h14" />
    <path d="M5 7.5 2.8 13a3 3 0 0 0 4.4 0z" />
    <path d="M19 7.5 16.8 13a3 3 0 0 0 4.4 0z" />
    <path d="M8.5 20.5h7" />
  </Svg>
)

export const IconLogout = (p) => (
  <Svg {...p}>
    <path d="M14.5 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2v-2" />
    <path d="M10 12h11M18 9l3 3-3 3" />
  </Svg>
)

export const IconGlobe = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
    <path d="M12 3c-2.5 2.4-3.8 5.5-3.8 9s1.3 6.6 3.8 9c2.5-2.4 3.8-5.5 3.8-9S14.5 5.4 12 3z" />
  </Svg>
)

export const IconMenu = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const IconClose = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconTrendUp = (p) => (
  <Svg {...p}>
    <path d="M3 16.5 9 10l4 4 8-8" />
    <path d="M15 6h6v6" />
  </Svg>
)

export const IconChevronDown = (p) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const IconSun = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
)

export const IconMoon = (p) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
)

export const IconCampaign = (p) => (
  <Svg {...p}>
    <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z" />
    <path d="M15 8a4 4 0 0 1 0 8M18 5a8 8 0 0 1 0 14" />
  </Svg>
)

export const IconFolder = (p) => (
  <Svg {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
  </Svg>
)

export const IconFolderOpen = (p) => (
  <Svg {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
    <path d="M2 10h20" />
  </Svg>
)

export const IconFileText = (p) => (
  <Svg {...p}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <path d="M14 2v6h6M8 13h8M8 17h6" />
  </Svg>
)

export const IconPencil = (p) => (
  <Svg {...p}>
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </Svg>
)

export const IconTrash = (p) => (
  <Svg {...p}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Svg>
)

export const IconExport = (p) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Svg>
)

export const IconImport = (p) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Svg>
)

export const IconPrinter = (p) => (
  <Svg {...p}>
    <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" rx="1" />
  </Svg>
)

export const IconTarget = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </Svg>
)

export const IconBuilding = (p) => (
  <Svg {...p}>
    <path d="M3 21h18M3 7l9-4 9 4M4 10h16v11H4z" />
    <path d="M9 21v-4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4M8 14h.01M12 14h.01M16 14h.01" />
  </Svg>
)

export const IconUser = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="7" r="4" />
    <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
  </Svg>
)

export const IconDocumentText = (p) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </Svg>
)

export const IconArrowDownRight = (p) => (
  <Svg {...p}>
    <path d="m7 7 10 10M17 7v10H7" />
  </Svg>
)

export const IconArrowUpRight = (p) => (
  <Svg {...p}>
    <path d="M7 17 17 7M7 7h10v10" />
  </Svg>
)

export const IconMinus = (p) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
)

export const IconPlus = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconStar = (p) => (
  <Svg {...p}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </Svg>
)

export const IconCheck = (p) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
)

export const IconGrid = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </Svg>
)

export const IconList = (p) => (
  <Svg {...p}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </Svg>
)

export const IconLayers = (p) => (
  <Svg {...p}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </Svg>
)

export const IconScale = (p) => (
  <Svg {...p}>
    <line x1="12" y1="3" x2="12" y2="21" />
    <polyline points="4 7 12 5 20 7" />
    <path d="M4 7l-2 7h6l-2-7" />
    <path d="M20 7l-2 7h6l-2-7" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </Svg>
)

