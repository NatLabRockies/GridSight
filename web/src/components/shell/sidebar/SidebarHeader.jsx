import React from "react";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import QrCode2Icon from "@mui/icons-material/QrCode2";
import StoryPicker from "../../controllers/StoryPicker.jsx";
import StoryEditor from "../../story/StoryEditor.jsx";
import { openSyncedTab } from "../../../lib/stateBus.js";

/**
 * Sidebar header block — story picker, story editor, and the three
 * window-management shortcut links (mirror display, command center,
 * give control).
 *
 * Rendered only when the drawer is in "full" mode (showLabels).
 */
export default function SidebarHeader({
  activeStory,
  activePerspective,
  onActiveStoryChange,
  onApplyChapter,
  onCapture,
  onGiveControlOpen,
}) {
  return (
    <Box sx={{ px: 1.5, py: 1 }}>
      <StoryPicker value={activeStory} onChange={onActiveStoryChange} />
      <StoryEditor
        storyId={activeStory}
        activePerspectiveId={activePerspective}
        onApplyChapter={onApplyChapter}
        onCapture={onCapture}
      />
      <Divider sx={{ my: 1 }} />
      {/* Duplicate the main map into a second native window. Both
          windows publish + receive on every channel, so dragging
          the viewport, toggling layers, scrubbing time, etc. stays
          in lockstep. Primary use case is multi-monitor setups
          (Insight2D viz wall) where the operator wants the same
          map mirrored across two displays. */}
      <Box
        onClick={() => openSyncedTab({})}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mt: 0.5,
          px: 1,
          py: 0.5,
          borderRadius: 0.5,
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
        }}
      >
        <OpenInNewIcon sx={{ fontSize: 14 }} />
        <Typography variant="caption">Open mirror display</Typography>
      </Box>
      {/* Open a tablet-oriented controller tab that joins this
          session and pre-loads every registered control panel.
          Useful when the main display is driven by a second
          machine (Insight2D) and the operator wants a light
          touch-screen interface on a tablet. */}
      <Box
        onClick={() => openSyncedTab({
          view: 'control',
          sync: { viewport: false, charts: false },
        })}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mt: 0.25,
          px: 1,
          py: 0.5,
          borderRadius: 0.5,
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
        }}
      >
        <OpenInNewIcon sx={{ fontSize: 14 }} />
        <Typography variant="caption">Open command center</Typography>
      </Box>
      {/* Operator-only: hand a guest a QR code or one-time pass-
          code to drive this display from a phone or tablet. */}
      <Box
        onClick={onGiveControlOpen}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mt: 0.25,
          px: 1,
          py: 0.5,
          borderRadius: 0.5,
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
        }}
      >
        <QrCode2Icon sx={{ fontSize: 14 }} />
        <Typography variant="caption">Give control…</Typography>
      </Box>
    </Box>
  );
}
