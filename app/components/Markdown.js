// Small, dependency-free markdown renderer for chat bubbles. Only supports the
// subset of markdown the system prompt asks the LLM to produce (bold, inline
// code, pipe tables, bullet/numbered lists, headings, paragraphs) - intentionally
// not a full CommonMark implementation, and never uses dangerouslySetInnerHTML
// so there's no HTML/script injection risk from LLM-generated content.
import styles from './Markdown.module.css';

// Splits a line of text on **bold** / `code` spans and returns an array of
// strings and small React elements (<strong>/<code>).
function renderInline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(\*\*(.+?)\*\*|`([^`]+?)`)/g;
  let lastIndex = 0;
  let match;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${i}`} className={styles.bold}>
          {match[2]}
        </strong>
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c-${i}`} className={styles.inlineCode}>
          {match[3]}
        </code>
      );
    }
    lastIndex = pattern.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isTableSeparatorLine(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines, key) {
  const header = splitTableRow(lines[0]);
  const bodyLines = lines.slice(2);
  return (
    <div className={styles.tableWrap} key={key}>
      <table className={styles.table}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{renderInline(cell, `${key}-h${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyLines.map((line, r) => {
            const cells = splitTableRow(line);
            return (
              <tr key={r}>
                {cells.map((cell, c) => (
                  <td key={c}>{renderInline(cell, `${key}-r${r}c${c}`)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderList(lines, ordered, key) {
  const Tag = ordered ? 'ol' : 'ul';
  const items = lines.map((line) =>
    line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
  );
  return (
    <Tag className={styles.list} key={key}>
      {items.map((item, i) => (
        <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
      ))}
    </Tag>
  );
}

// Parses `text` into block-level React elements (paragraphs, headings, lists,
// tables), each paragraph/list item further parsed for inline bold/code spans.
// `variant` ('bot' | 'user') only controls the bold/code color scheme so bold
// text stays readable against the solid-color user bubble.
export default function Markdown({ text, variant = 'bot' }) {
  if (!text) return null;

  const lines = String(text).split('\n');
  const blocks = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Heading: #, ##, ###
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const HeadingTag = `h${Math.min(level + 3, 6)}`;
      blocks.push(
        <HeadingTag className={styles.heading} key={blockKey++}>
          {renderInline(headingMatch[2], `h-${blockKey}`)}
        </HeadingTag>
      );
      i += 1;
      continue;
    }

    // Table: a row of | cells | followed by a separator row of | --- |
    if (line.includes('|') && lines[i + 1] && isTableSeparatorLine(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        tableLines.push(lines[j]);
        j += 1;
      }
      blocks.push(renderTable(tableLines, blockKey++));
      i = j;
      continue;
    }

    // Unordered / ordered list
    const isBullet = /^\s*[-*]\s+/.test(line);
    const isNumbered = /^\s*\d+\.\s+/.test(line);
    if (isBullet || isNumbered) {
      const listLines = [line];
      let j = i + 1;
      while (
        j < lines.length &&
        (isBullet ? /^\s*[-*]\s+/.test(lines[j]) : /^\s*\d+\.\s+/.test(lines[j]))
      ) {
        listLines.push(lines[j]);
        j += 1;
      }
      blocks.push(renderList(listLines, isNumbered, blockKey++));
      i = j;
      continue;
    }

    // Paragraph: consume until a blank line or the start of a table/list/heading
    const paraLines = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[j]) &&
      !/^\s*[-*]\s+/.test(lines[j]) &&
      !/^\s*\d+\.\s+/.test(lines[j]) &&
      !(lines[j].includes('|') && lines[j + 1] && isTableSeparatorLine(lines[j + 1]))
    ) {
      paraLines.push(lines[j]);
      j += 1;
    }
    blocks.push(
      <p className={styles.paragraph} key={blockKey++}>
        {paraLines.map((paraLine, idx) => (
          <span key={idx}>
            {renderInline(paraLine, `p-${blockKey}-${idx}`)}
            {idx < paraLines.length - 1 && <br />}
          </span>
        ))}
      </p>
    );
    i = j;
  }

  return (
    <div className={`${styles.markdown} ${variant === 'user' ? styles.userVariant : ''}`}>
      {blocks}
    </div>
  );
}
