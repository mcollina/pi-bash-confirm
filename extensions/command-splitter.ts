export function splitCommand(command, options = {}) {
  const depthLimit = Number.isFinite(options.depthLimit) ? options.depthLimit : 5;
  return parseCommand(String(command ?? ""), 0, depthLimit);
}

function parseCommand(input, depth, depthLimit) {
  if (depth > depthLimit) {
    return { segments: [], operators: [], requiresConfirmation: true };
  }

  const segments = [];
  const operators = [];
  let requiresConfirmation = false;
  let current = "";
  let quote = null;
  let escape = false;
  let nestedSegments = [];
  let nestedOperators = [];

  const pushSegment = (fromOperator = false) => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    } else if (current.length > 0 || fromOperator) {
      requiresConfirmation = true;
    }
    if (nestedSegments.length > 0) {
      segments.push(...nestedSegments);
      operators.push(...nestedOperators);
    }
    nestedSegments = [];
    nestedOperators = [];
    current = "";
  };

  for (let i = 0; i < input.length; ) {
    const char = input[i];

    if (escape) {
      current += char;
      escape = false;
      i += 1;
      continue;
    }

    if (char === "\\") {
      current += char;
      escape = true;
      i += 1;
      continue;
    }

    if (quote) {
      if (quote === "'" && char === "'") {
        quote = null;
      } else if (quote === '"' && char === '"') {
        quote = null;
      }
      current += char;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i += 1;
      continue;
    }

    if (char === "$" && input[i + 1] === "(") {
      if (depth + 1 > depthLimit) {
        requiresConfirmation = true;
        return { segments, operators, requiresConfirmation };
      }
      const extraction = extractCommandSubstitution(input, i + 2);
      if (extraction.aborted) {
        requiresConfirmation = true;
        return { segments, operators, requiresConfirmation };
      }
      const inner = parseCommand(extraction.content, depth + 1, depthLimit);
      current += `$(${extraction.content})`;
      if (inner.requiresConfirmation) {
        requiresConfirmation = true;
      }
      nestedSegments.push(...inner.segments);
      nestedOperators.push(...inner.operators);
      i = extraction.endIndex + 1;
      continue;
    }

    if (char === "`") {
      if (depth + 1 > depthLimit) {
        requiresConfirmation = true;
        return { segments, operators, requiresConfirmation };
      }
      const extraction = extractBacktick(input, i + 1);
      if (extraction.aborted) {
        requiresConfirmation = true;
        return { segments, operators, requiresConfirmation };
      }
      const inner = parseCommand(extraction.content, depth + 1, depthLimit);
      current += `\`${extraction.content}\``;
      if (inner.requiresConfirmation) {
        requiresConfirmation = true;
      }
      nestedSegments.push(...inner.segments);
      nestedOperators.push(...inner.operators);
      i = extraction.endIndex + 1;
      continue;
    }

    if (char === "&" && input[i + 1] === "&") {
      pushSegment(true);
      operators.push("&&");
      i += 2;
      continue;
    }

    if (char === "|" && input[i + 1] === "|") {
      pushSegment(true);
      operators.push("||");
      i += 2;
      continue;
    }

    if (char === "|") {
      pushSegment(true);
      operators.push("|");
      i += 1;
      continue;
    }

    if (char === ";") {
      pushSegment(true);
      operators.push(";");
      i += 1;
      continue;
    }

    if (char === "\n") {
      pushSegment(true);
      operators.push("\n");
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  pushSegment(false);

  return { segments, operators, requiresConfirmation };
}

function extractCommandSubstitution(input, startIndex) {
  let quote = null;
  let escape = false;
  let depth = 1;

  for (let i = startIndex; i < input.length; i += 1) {
    const char = input[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (quote === "'" && char === "'") {
        quote = null;
      } else if (quote === '"' && char === '"') {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "`") {
      const backtick = extractBacktick(input, i + 1);
      if (backtick.aborted) {
        return { content: input.slice(startIndex), endIndex: input.length - 1, aborted: true };
      }
      i = backtick.endIndex;
      continue;
    }

    if (char === "$" && input[i + 1] === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { content: input.slice(startIndex, i), endIndex: i, aborted: false };
      }
    }
  }

  return { content: input.slice(startIndex), endIndex: input.length - 1, aborted: true };
}

function extractBacktick(input, startIndex) {
  let escape = false;

  for (let i = startIndex; i < input.length; i += 1) {
    const char = input[i];
    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === "`") {
      return { content: input.slice(startIndex, i), endIndex: i, aborted: false };
    }
  }

  return { content: input.slice(startIndex), endIndex: input.length - 1, aborted: true };
}
