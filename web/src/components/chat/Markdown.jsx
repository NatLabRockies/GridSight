import Box from '@mui/material/Box';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * Markdown — renders assistant chat content as GitHub-flavored markdown
 * (tables, lists, code, bold/italic, links). remark-breaks keeps single
 * newlines as line breaks so prose reads like the old pre-wrap rendering.
 *
 * react-markdown does not render raw HTML by default, so AI output can't
 * inject markup. Links open in a new tab with noopener.
 *
 * Styled to sit inside the dark chat bubble: compact margins, bordered
 * tables that scroll horizontally when wide, subtle code backgrounds.
 */
export default function Markdown({ children }) {
  return (
    <Box
      sx={{
        fontSize: 14,
        lineHeight: 1.5,
        wordBreak: 'break-word',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { m: 0, mb: 0.75 },
        '& ul, & ol': { m: 0, mb: 0.75, pl: 2.5 },
        '& li': { mb: 0.25 },
        '& h1, & h2, & h3, & h4': { mt: 1, mb: 0.5, fontSize: '1.05em', fontWeight: 700 },
        '& a': { color: 'primary.light', textDecoration: 'underline' },
        '& code': {
          fontFamily: 'monospace',
          fontSize: '0.85em',
          bgcolor: 'rgba(255,255,255,0.1)',
          px: 0.5,
          py: 0.1,
          borderRadius: 0.5,
        },
        '& pre': {
          bgcolor: 'rgba(0,0,0,0.35)',
          p: 1,
          borderRadius: 1,
          overflow: 'auto',
          my: 0.75,
        },
        '& pre code': { bgcolor: 'transparent', p: 0, fontSize: '0.85em' },
        '& blockquote': {
          m: 0,
          my: 0.75,
          pl: 1,
          borderLeft: '3px solid',
          borderColor: 'divider',
          color: 'text.secondary',
        },
        // Tables: scroll horizontally rather than overflow the bubble.
        '& .md-table-wrap': { overflowX: 'auto', my: 0.75 },
        '& table': { borderCollapse: 'collapse', width: 'auto', fontSize: '0.9em' },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'divider',
          px: 1,
          py: 0.5,
          textAlign: 'left',
          whiteSpace: 'nowrap',
        },
        '& th': { bgcolor: 'rgba(255,255,255,0.08)', fontWeight: 700 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          // Wrap tables so they can scroll horizontally inside the bubble.
          table: ({ node, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}
