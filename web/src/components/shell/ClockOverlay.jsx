import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Draggable from "react-draggable";

export default function ClockOverlay({
  show,
  position,
  fontSize,
  color,
  displayText,
  onDragStart,
  onDragStop,
  onResizePointerDown,
}) {
  if (!show) return null;
  return (
    <Box>
      <Draggable
        defaultPosition={position}
        onStart={onDragStart}
        onStop={onDragStop}
        cancel=".clock-resize-handle"
      >
        <Box
          sx={{
            position: "absolute",
            cursor: "grab",
            userSelect: "none",
            display: "inline-flex",
            alignItems: "center",
            px: 1.5,
            py: 0.5,
            borderRadius: 1,
            backdropFilter: "blur(6px)",
            bgcolor: "rgba(0,0,0,0.45)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Typography
            id="Clock"
            sx={{
              color,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontWeight: 700,
              fontSize,
              letterSpacing: 1,
              textShadow: "0 1px 4px rgba(0,0,0,0.6)",
              whiteSpace: "nowrap",
            }}
          >
            {displayText}
          </Typography>
          {/* Resize grip — drag vertically to change font size */}
          <Box
            className="clock-resize-handle"
            onPointerDown={onResizePointerDown}
            sx={{
              position: "absolute",
              bottom: 0,
              right: 0,
              width: 14,
              height: 14,
              cursor: "nwse-resize",
              opacity: 0.4,
              "&:hover": { opacity: 0.8 },
              // Triangle grip indicator
              "&::after": {
                content: '""',
                position: "absolute",
                bottom: 2,
                right: 2,
                width: 0,
                height: 0,
                borderStyle: "solid",
                borderWidth: "0 0 8px 8px",
                borderColor: "transparent transparent rgba(255,255,255,0.6) transparent",
              },
            }}
          />
        </Box>
      </Draggable>
    </Box>
  );
}
