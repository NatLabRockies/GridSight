import { useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

/**
 * VegaLiteRenderer — renders a Vega-Lite JSON spec using vega-embed.
 * Automatically adapts to the active MUI theme (dark/light).
 *
 * Props:
 *   spec: Vega-Lite JSON object (must include $schema, data, mark, encoding)
 *   width: container width
 *   height: container height
 */
export default function VegaLiteRenderer({ spec, width = 480, height = 340 }) {
  const containerRef = useRef(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const chartTheme = theme.custom?.chart ?? {};

  useEffect(() => {
    if (!containerRef.current || !spec) return;
    let cancelled = false;

    import('vega-embed').then((mod) => {
      if (cancelled || !containerRef.current) return;
      const vegaEmbed = mod.default || mod;

      const textColor = isDark ? (chartTheme.tickColor ?? '#ccc') : '#333';
      const gridColor = isDark ? (chartTheme.gridColor ?? '#333') : 'rgba(0,0,0,0.1)';

      const fullSpec = {
        ...spec,
        width: width - 60,
        height: height - 60,
        config: {
          background: 'transparent',
          axis: { labelColor: textColor, titleColor: textColor, gridColor },
          legend: { labelColor: textColor, titleColor: textColor },
          title: { color: textColor },
          view: { stroke: 'transparent' },
          ...spec.config,
        },
      };

      vegaEmbed(containerRef.current, fullSpec, {
        actions: false,
        renderer: 'canvas',
        theme: isDark ? 'dark' : undefined,
      }).catch((err) => {
        console.warn('[VegaLiteRenderer] embed failed:', err);
      });
    }).catch((err) => {
      console.warn('[VegaLiteRenderer] failed to load vega-embed:', err);
    });

    return () => {
      cancelled = true;
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [spec, width, height, isDark, chartTheme.tickColor, chartTheme.gridColor]);

  if (!spec) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ p: 1 }}>
        No Vega-Lite spec available
      </Typography>
    );
  }

  return <Box ref={containerRef} sx={{ width, height }} />;
}
