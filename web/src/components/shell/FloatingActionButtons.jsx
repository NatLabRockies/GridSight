import React from "react";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SyncIcon from "@mui/icons-material/Sync";
import SyncDisabledIcon from "@mui/icons-material/SyncDisabled";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import bus from "../../lib/stateBus.js";

/**
 * The two persistent corner buttons:
 *  • bottom-left  — Tab Sync Settings toggle (color reflects active session)
 *  • bottom-right — AI Chat toggle (suppressed in display-only mode)
 */
export default function FloatingActionButtons({
  isDisplay,
  sessionColor,
  syncSettingsOpen,
  chatOpen,
  chatExpanded,
  chatRightInset = 0,   // width of the right-side chart tray; shift the chat FAB left of it
  onSyncSettingsToggle,
  onChatToggle,
}) {
  return (
    <>
      <Tooltip title={
        bus.isConnected()
          ? `${bus.getSessionType() === 'remote' ? 'Remote' : 'Local'} session${bus.getRemoteSessionKey() ? ` — Key: ${bus.getRemoteSessionKey()}` : ''}`
          : 'Tab Sync Settings'
      }>
        <IconButton
          size="small"
          onClick={onSyncSettingsToggle}
          sx={{
            position: 'fixed',
            bottom: 12,
            left: 12,
            zIndex: 1500,
            bgcolor: syncSettingsOpen ? 'primary.main' : sessionColor || 'rgba(30,30,30,0.85)',
            color: (syncSettingsOpen || sessionColor) ? '#fff' : 'text.secondary',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.15)',
            '&:hover': { bgcolor: syncSettingsOpen ? 'primary.dark' : sessionColor || 'rgba(50,50,50,0.9)', opacity: 0.9 },
            width: 32,
            height: 32,
          }}
        >
          {bus.isConnected() ? <SyncIcon sx={{ fontSize: 16 }} /> : <SyncDisabledIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      {/* Hidden while the Atlas drawer is expanded — it fills the bottom-right
          corner, so the FAB would overlap the composer's send button. The
          drawer has its own close/collapse controls. */}
      {!isDisplay && !chatExpanded && (
        <Tooltip title="AI Chat">
          <IconButton
            size="small"
            onClick={onChatToggle}
            sx={{
              position: 'fixed',
              bottom: 12,
              right: 12 + (chatRightInset ? chatRightInset + 12 : 0),
              zIndex: 1500,
              transition: 'right 0.2s ease',
              bgcolor: chatOpen ? 'primary.main' : 'rgba(30,30,30,0.85)',
              color: chatOpen ? 'primary.contrastText' : 'text.secondary',
              backdropFilter: 'blur(6px)',
              border: '1px solid rgba(255,255,255,0.15)',
              '&:hover': { bgcolor: chatOpen ? 'primary.dark' : 'rgba(50,50,50,0.9)' },
              width: 32,
              height: 32,
            }}
          >
            <AutoAwesomeIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}
