/**
 * 灵感词库 · 每日早 8 点自动更新脚本（D1 生产版）
 * 运行环境：Node.js 20+（零第三方依赖）
 *
 * 环境变量：
 *   GEMINI_API_KEY       必填，Google AI Studio / Gemini API Key
 *   GEMINI_MODEL         可选，默认 gemini-3.8-flash
 *   FEEDBACK_API_URL     可选，Cloudflare Worker 状态接口（如 https://xxx.workers.dev/api/state）
 *   FEEDBACK_API_TOKEN   可选，Worker 鉴权 Bearer Token
 *   TARGET_DATE          可选，指定生成日期 YYYY-MM-DD（默认按北京时间当天）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlockedByKtvList, normalizeText, verifySongWithLrclib } from './verify_lyrics.mjs';
import { resolveYoutubeId, resolveItunesPreview, resolveAudioSources } from './resolve_audio.mjs';


/* Vendored jsonrepair 3.15.0, https://github.com/josdejong/jsonrepair
The ISC License

Copyright (c) 2020-2026 by Jos de Jong

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

*/
const { jsonrepair } = (() => {
  const exports = {};


  class JSONRepairError extends Error {
    constructor(message, position) {
      super(`${message} at position ${position}`);
      this.position = position;
    }
  }

  const codeSpace = 0x20; // " "
  const codeNewline = 0xa; // "\n"
  const codeTab = 0x9; // "\t"
  const codeReturn = 0xd; // "\r"

  // unicode spaces: https://jkorpela.fi/chars/spaces.html
  const codeNonBreakingSpace = 0x00a0;
  const codeMongolianVowelSeparator = 0x180e;
  const codeEnQuad = 0x2000;
  const codeZeroWidthSpace = 0x200b;
  const codeNarrowNoBreakSpace = 0x202f;
  const codeMediumMathematicalSpace = 0x205f;
  const codeIdeographicSpace = 0x3000;
  const codeZeroWidthNoBreakSpace = 0xfeff;
  function isHex(char) {
    return /^[0-9A-Fa-f]$/.test(char);
  }
  function isDigit(char) {
    return char >= '0' && char <= '9';
  }
  function isValidStringCharacter(char) {
    // note that the valid range is between \u{0020} and \u{10ffff},
    // but in JavaScript it is not possible to create a code point larger than
    // \u{10ffff}, so there is no need to test for that here.
    return char >= '\u0020';
  }
  function isDelimiter(char) {
    return ',:[]/{}()\n+'.includes(char);
  }
  function isFunctionNameCharStart(char) {
    return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char === '_' || char === '$';
  }
  function isFunctionNameChar(char) {
    return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char === '_' || char === '$' || char >= '0' && char <= '9';
  }

  // matches "https://" and other schemas
  const regexUrlStart = /^(http|https|ftp|mailto|file|data|irc):\/\/$/;

  // matches all valid URL characters EXCEPT "[", "]", and ",", since that are important JSON delimiters
  const regexUrlChar = /^[A-Za-z0-9-._~:/?#@!$&'()*+;=]$/;
  function isUnquotedStringDelimiter(char) {
    return ',[]/{}\n+'.includes(char);
  }
  function isStartOfValue(char) {
    return isQuote(char) || regexStartOfValue.test(char);
  }

  // alpha, number, minus, or opening bracket or brace
  const regexStartOfValue = /^[[{\w-]$/;
  function isControlCharacter(char) {
    return char === '\n' || char === '\r' || char === '\t' || char === '\b' || char === '\f';
  }
  /**
   * Check if the given character is a whitespace character like space, tab, or
   * newline
   */
  function isWhitespace(text, index) {
    const code = text.charCodeAt(index);
    return code === codeSpace || code === codeNewline || code === codeTab || code === codeReturn;
  }

  /**
   * Check if the given character is a whitespace character like space or tab,
   * but NOT a newline
   */
  function isWhitespaceExceptNewline(text, index) {
    const code = text.charCodeAt(index);
    return code === codeSpace || code === codeTab || code === codeReturn;
  }

  /**
   * Check if the given character is a special whitespace character, some
   * unicode variant
   */
  function isSpecialWhitespace(text, index) {
    const code = text.charCodeAt(index);
    return code === codeNonBreakingSpace || code === codeMongolianVowelSeparator || code >= codeEnQuad && code <= codeZeroWidthSpace || code === codeNarrowNoBreakSpace || code === codeMediumMathematicalSpace || code === codeIdeographicSpace || code === codeZeroWidthNoBreakSpace;
  }

  /**
   * Test whether the given character is a quote or double quote character.
   * Also tests for special variants of quotes.
   */
  function isQuote(char) {
    // the first check double quotes, since that occurs most often
    return isDoubleQuoteLike(char) || isSingleQuoteLike(char);
  }

  /**
   * Test whether the given character is a double quote character.
   * Also tests for special variants of double quotes.
   */
  function isDoubleQuoteLike(char) {
    return char === '"' || char === '\u201c' || char === '\u201d';
  }

  /**
   * Test whether the given character is a double quote character.
   * Does NOT test for special variants of double quotes.
   */
  function isDoubleQuote(char) {
    return char === '"';
  }

  /**
   * Test whether the given character is a single quote character.
   * Also tests for special variants of single quotes.
   */
  function isSingleQuoteLike(char) {
    return char === "'" || char === '\u2018' || char === '\u2019' || char === '\u0060' || char === '\u00b4';
  }

  /**
   * Test whether the given character is a single quote character.
   * Does NOT test for special variants of single quotes.
   */
  function isSingleQuote(char) {
    return char === "'";
  }

  /**
   * Strip last occurrence of textToStrip from text
   */
  function stripLastOccurrence(text, textToStrip) {
    let stripRemainingText = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    const index = text.lastIndexOf(textToStrip);
    return index !== -1 ? text.substring(0, index) + (stripRemainingText ? '' : text.substring(index + 1)) : text;
  }
  function insertBeforeLastWhitespace(text, textToInsert) {
    let index = text.length;
    if (!isWhitespace(text, index - 1)) {
      // no trailing whitespaces
      return text + textToInsert;
    }
    while (isWhitespace(text, index - 1)) {
      index--;
    }
    return text.substring(0, index) + textToInsert + text.substring(index);
  }
  function removeAtIndex(text, start, count) {
    return text.substring(0, start) + text.substring(start + count);
  }

  /**
   * Test whether a string ends with a newline or comma character and optional whitespace
   */
  function endsWithCommaOrNewline(text) {
    return /[,\n][ \t\r]*$/.test(text);
  }
  const namedHtmlEntities = {
    '&quot;': '"',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&apos;': "'"
  };

  // the longest entity we need to recognize is a numeric one like "&#x10FFFF;"
  // (10 chars), so a window of 12 characters is always enough
  const maxHtmlEntityLength = 12;
  /**
   * Try to match an HTML entity at the start of the given fragment. The fragment
   * is a small slice of text that begins exactly at the candidate '&'. Returns the
   * decoded character and the number of characters consumed, or null when there
   * is no complete, valid entity (for example a truncated "&quot" without ';').
   */
  function matchHtmlEntity(fragment) {
    if (fragment.charAt(0) !== '&') {
      return null;
    }
    const semicolon = fragment.indexOf(';');
    if (semicolon === -1) {
      return null;
    }
    const entity = fragment.substring(0, semicolon + 1);
    const named = namedHtmlEntities[entity];
    if (named !== undefined) {
      return {
        char: named,
        length: entity.length
      };
    }
    if (fragment.charAt(1) === '#') {
      const body = fragment.substring(2, semicolon);
      const hex = body.charAt(0) === 'x' || body.charAt(0) === 'X';
      const digits = hex ? body.substring(1) : body;
      if (digits.length > 0) {
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
          return {
            char: String.fromCodePoint(code),
            length: entity.length
          };
        }
      }
    }
    return null;
  }

  /**
   * Test whether a matched HTML entity decodes to a double quote character
   */
  function isDoubleQuoteEntity(match) {
    return match !== null && match.char === '"';
  }

  /**
   * Test whether a matched HTML entity decodes to a single quote character
   */
  function isSingleQuoteEntity(match) {
    return match !== null && match.char === "'";
  }

  /**
   * Count the number of occurrences of a single character in a string
   */
  function countOccurrences(text, char) {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charAt(i) === char) {
        count++;
      }
    }
    return count;
  }

  /**
   * Test whether `closeChar` is a closing bracket and `text` still contains an
   * unmatched opening bracket of the same kind. This indicates that the end of
   * `text` is located inside the brackets, for example the quote in
   * `"a (b") c"` is followed by `)` while `(` is still unclosed.
   *
   * Note that the (potentially expensive) counting is only performed when
   * `closeChar` actually is a closing bracket.
   */
  function isInsideUnclosedBracket(text, closeChar) {
    switch (closeChar) {
      case ')':
        return countOccurrences(text, '(') > countOccurrences(text, ')');
      case ']':
        return countOccurrences(text, '[') > countOccurrences(text, ']');
      case '}':
        return countOccurrences(text, '{') > countOccurrences(text, '}');
      default:
        return false;
    }
  }

  const controlCharacters = {
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t'
  };

  // map with all escape characters
  const escapeCharacters = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t'
    // note that \u is handled separately in parseString()
  };

  /**
   * Repair a string containing an invalid JSON document.
   * For example changes JavaScript notation into JSON notation.
   *
   * Example:
   *
   *     try {
   *       const json = "{name: 'John'}"
   *       const repaired = jsonrepair(json)
   *       console.log(repaired)
   *       // '{"name": "John"}'
   *     } catch (err) {
   *       console.error(err)
   *     }
   *
   */
  function jsonrepair(text) {
    let i = 0; // current index in text
    let output = ''; // generated output

    parseMarkdownCodeBlock(['```', '[```', '{```']);
    const processed = parseValue();
    if (!processed) {
      throwUnexpectedEnd();
    }
    parseMarkdownCodeBlock(['```', '```]', '```}']);
    const processedComma = parseCharacter(',');
    if (processedComma) {
      parseWhitespaceAndSkipComments();
    }
    if (isStartOfValue(text[i]) && endsWithCommaOrNewline(output)) {
      // start of a new value after end of the root level object: looks like
      // newline delimited JSON -> turn into a root level array
      if (!processedComma) {
        // repair missing comma
        output = insertBeforeLastWhitespace(output, ',');
      }
      parseNewlineDelimitedJSON();
    } else if (processedComma) {
      // repair: remove trailing comma
      output = stripLastOccurrence(output, ',');
    }

    // repair redundant end quotes
    while (text[i] === '}' || text[i] === ']') {
      i++;
      parseWhitespaceAndSkipComments();
    }
    if (i >= text.length) {
      // reached the end of the document properly
      return output;
    }
    throwUnexpectedCharacter();
    function parseValue() {
      parseWhitespaceAndSkipComments();
      const processed = parseObject() || parseArray() || parseString() || parseNumber() || parseKeywords() || parseUnquotedString(false) || parseRegex();
      parseWhitespaceAndSkipComments();
      return processed;
    }
    function parseWhitespaceAndSkipComments() {
      let skipNewline = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
      const start = i;
      let changed = parseWhitespace(skipNewline);
      do {
        changed = parseComment();
        if (changed) {
          changed = parseWhitespace(skipNewline);
        }
      } while (changed);
      return i > start;
    }
    function parseWhitespace(skipNewline) {
      const _isWhiteSpace = skipNewline ? isWhitespace : isWhitespaceExceptNewline;
      let whitespace = '';
      while (true) {
        if (_isWhiteSpace(text, i)) {
          whitespace += text[i];
          i++;
        } else if (isSpecialWhitespace(text, i)) {
          // repair special whitespace
          whitespace += ' ';
          i++;
        } else {
          break;
        }
      }
      if (whitespace.length > 0) {
        output += whitespace;
        return true;
      }
      return false;
    }
    function parseComment() {
      // find a block comment '/* ... */'
      if (text[i] === '/' && text[i + 1] === '*') {
        // repair block comment by skipping it
        while (i < text.length && !atEndOfBlockComment(text, i)) {
          i++;
        }
        i += 2;
        return true;
      }

      // find a line comment '// ...'
      if (text[i] === '/' && text[i + 1] === '/') {
        // repair line comment by skipping it
        while (i < text.length && text[i] !== '\n') {
          i++;
        }
        return true;
      }
      return false;
    }
    function parseMarkdownCodeBlock(blocks) {
      // find and skip over a Markdown fenced code block:
      //     ``` ... ```
      // or
      //     ```json ... ```
      if (skipMarkdownCodeBlock(blocks)) {
        if (isFunctionNameCharStart(text[i])) {
          // strip the optional language specifier like "json"
          while (i < text.length && isFunctionNameChar(text[i])) {
            i++;
          }
        }
        parseWhitespaceAndSkipComments();
        return true;
      }
      return false;
    }
    function skipMarkdownCodeBlock(blocks) {
      parseWhitespace(true);
      for (const block of blocks) {
        const end = i + block.length;
        if (text.slice(i, end) === block) {
          i = end;
          return true;
        }
      }
      return false;
    }
    function parseCharacter(char) {
      if (text[i] === char) {
        output += text[i];
        i++;
        return true;
      }
      return false;
    }
    function skipCharacter(char) {
      if (text[i] === char) {
        i++;
        return true;
      }
      return false;
    }
    function skipEscapeCharacter() {
      return skipCharacter('\\');
    }

    /**
     * Skip ellipsis like "[1,2,3,...]" or "[1,2,3,...,9]" or "[...,7,8,9]"
     * or a similar construct in objects.
     */
    function skipEllipsis() {
      parseWhitespaceAndSkipComments();
      if (text[i] === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
        // repair: remove the ellipsis (three dots) and optionally a comma
        i += 3;
        parseWhitespaceAndSkipComments();
        skipCharacter(',');
        return true;
      }
      return false;
    }

    /**
     * Parse an object like '{"key": "value"}'
     */
    function parseObject() {
      if (text[i] === '{') {
        output += '{';
        i++;
        parseWhitespaceAndSkipComments();

        // repair: skip leading comma like in {, message: "hi"}
        if (skipCharacter(',')) {
          parseWhitespaceAndSkipComments();
        }
        let initial = true;
        while (i < text.length && text[i] !== '}') {
          let processedComma;
          if (!initial) {
            processedComma = parseCharacter(',');
            if (!processedComma) {
              // repair missing comma
              output = insertBeforeLastWhitespace(output, ',');
            }
            parseWhitespaceAndSkipComments();
          } else {
            processedComma = true;
          }
          skipEllipsis();
          const processedKey = parseString() || parseUnquotedString(true);
          if (!processedKey) {
            if (text[i] === '}' || text[i] === '{' || text[i] === ']' || text[i] === '[' || text[i] === undefined) {
              // repair trailing comma
              if (!initial) {
                output = stripLastOccurrence(output, ',');
              }
            } else {
              throwObjectKeyExpected();
            }
            break;
          }
          parseWhitespaceAndSkipComments();
          const processedColon = parseCharacter(':');
          const truncatedText = i >= text.length;
          if (!processedColon) {
            if (isStartOfValue(text[i]) || truncatedText) {
              // repair missing colon
              output = insertBeforeLastWhitespace(output, ':');
            } else {
              throwColonExpected();
            }
          }
          const processedValue = parseValue();
          if (!processedValue) {
            if (processedColon || truncatedText) {
              // repair missing object value
              output += 'null';
            } else {
              throwColonExpected();
            }
          }
          initial = false;
        }
        if (text[i] === '}') {
          output += '}';
          i++;
        } else {
          // repair missing end bracket
          output = insertBeforeLastWhitespace(output, '}');
        }
        return true;
      }
      return false;
    }

    /**
     * Parse an array like '["item1", "item2", ...]'
     */
    function parseArray() {
      if (text[i] === '[') {
        output += '[';
        i++;
        parseWhitespaceAndSkipComments();

        // repair: skip leading comma like in [,1,2,3]
        if (skipCharacter(',')) {
          parseWhitespaceAndSkipComments();
        }
        let initial = true;
        while (i < text.length && text[i] !== ']') {
          if (!initial) {
            const processedComma = parseCharacter(',');
            if (!processedComma) {
              // repair missing comma
              output = insertBeforeLastWhitespace(output, ',');
            }
          }
          skipEllipsis();
          const processedValue = parseValue();
          if (!processedValue) {
            // repair trailing comma
            if (!initial) {
              output = stripLastOccurrence(output, ',');
            }
            break;
          }
          initial = false;
        }
        if (text[i] === ']') {
          output += ']';
          i++;
        } else {
          // repair missing closing array bracket
          output = insertBeforeLastWhitespace(output, ']');
        }
        return true;
      }
      return false;
    }

    /**
     * Parse and repair Newline Delimited JSON (NDJSON):
     * multiple JSON objects separated by a newline character
     */
    function parseNewlineDelimitedJSON() {
      // repair NDJSON
      let initial = true;
      let processedValue = true;
      while (processedValue) {
        if (!initial) {
          // parse optional comma, insert when missing
          const processedComma = parseCharacter(',');
          if (!processedComma) {
            // repair: add missing comma
            output = insertBeforeLastWhitespace(output, ',');
          }
        } else {
          initial = false;
        }
        processedValue = parseValue();
      }
      if (!processedValue) {
        // repair: remove trailing comma
        output = stripLastOccurrence(output, ',');
      }

      // repair: wrap the output inside array brackets
      output = `[\n${output}\n]`;
    }

    /**
     * Parse a string enclosed by double quotes "...". Can contain escaped quotes
     * Repair strings enclosed in single quotes or special quotes
     * Repair an escaped string
     *
     * The function can run in two stages:
     * - First, it assumes the string has a valid end quote
     * - If it turns out that the string does not have a valid end quote followed
     *   by a delimiter (which should be the case), the function runs again in a
     *   more conservative way, stopping the string at the first next delimiter
     *   and fixing the string by inserting a quote there, or stopping at a
     *   stop index detected in the first iteration.
     */
    function parseString() {
      let stopAtDelimiter = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
      let stopAtIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : -1;
      const skipEscapeChars = text[i] === '\\';
      if (skipEscapeChars) {
        // repair: remove the first escape character
        i++;
        if (!isQuote(text[i])) {
          throwUnexpectedCharacter();
        }
      }

      // a string can be opened by a quote character, or by an HTML entity that
      // decodes to a quote (like &quot;) when repairing HTML-encoded JSON
      const openEntity = text[i] === '&' ? matchHtmlEntity(text.slice(i, i + maxHtmlEntityLength)) : null;
      const openedByEntity = isDoubleQuoteEntity(openEntity) || isSingleQuoteEntity(openEntity);
      if (isQuote(text[i]) || openedByEntity) {
        // double quotes are correct JSON,
        // single quotes come from JavaScript for example, we assume it will have a correct single end quote too
        // otherwise, we will match any double-quote-like start with a double-quote-like end,
        // or any single-quote-like start with a single-quote-like end
        const isEndQuote = isDoubleQuote(text[i]) ? isDoubleQuote : isSingleQuote(text[i]) ? isSingleQuote : isSingleQuoteLike(text[i]) ? isSingleQuoteLike : isDoubleQuoteLike;
        const iBefore = i;
        const oBefore = output.length;
        let str = '"';
        // when opened by an entity, skip past the whole entity; otherwise skip the quote
        i += openedByEntity && openEntity ? openEntity.length : 1;
        while (true) {
          if (i >= text.length) {
            // end of text, we are missing an end quote

            const iPrev = prevNonWhitespaceIndex(i - 1);
            if (!stopAtDelimiter && isDelimiter(text.charAt(iPrev))) {
              // if the text ends with a delimiter, like ["hello],
              // so the missing end quote should be inserted before this delimiter
              // retry parsing the string, stopping at the first next delimiter
              i = iBefore;
              output = output.substring(0, oBefore);
              return parseString(true);
            }

            // repair missing quote
            str = insertBeforeLastWhitespace(str, '"');
            output += str;
            return true;
          }
          if (i === stopAtIndex) {
            // use the stop index detected in the first iteration, and repair end quote
            str = insertBeforeLastWhitespace(str, '"');
            output += str;
            return true;
          }

          // inside an entity-opened string a '&' is an entity; it is the end quote
          // when it decodes to the opening quote
          const entity = openedByEntity && text[i] === '&' ? matchHtmlEntity(text.slice(i, i + maxHtmlEntityLength)) : null;
          const isEnd = entity && openEntity ? entity.char === openEntity.char : isEndQuote(text[i]);
          if (isEnd) {
            // end quote
            // let us check what is before and after the quote to verify whether this is a legit end quote
            const iQuote = i;
            const oQuote = str.length;
            str += '"';
            i += entity ? entity.length : 1;
            output += str;
            parseWhitespaceAndSkipComments(false);
            if (stopAtDelimiter || i >= text.length || isDelimiter(text[i]) &&
            // only count the brackets inside the string when actually needed,
            // i.e. when the quote is directly followed by a closing bracket
            !isInsideUnclosedBracket(str, text[i]) || isQuote(text[i]) && !nextQuoteIsEndQuote(i) || isDigit(text[i])) {
              // The quote is followed by the end of the text, a delimiter,
              // or a next value. So the quote is indeed the end of the string.
              parseConcatenatedString();
              return true;
            }
            if (text[i] === '\\') {
              throwUnexpectedCharacter();
            }
            const iPrevChar = prevNonWhitespaceIndex(iQuote - 1);
            const prevChar = text.charAt(iPrevChar);
            if (prevChar === ',') {
              // A comma followed by a quote, like '{"a":"b,c,"d":"e"}'.
              // We assume that the quote is a start quote, and that the end quote
              // should have been located right before the comma but is missing.
              i = iBefore;
              output = output.substring(0, oBefore);
              return parseString(false, iPrevChar);
            }
            if (isDelimiter(prevChar)) {
              // This is not the right end quote: it is preceded by a delimiter,
              // and NOT followed by a delimiter. So, there is an end quote missing
              // parse the string again and then stop at the first next delimiter
              i = iBefore;
              output = output.substring(0, oBefore);
              return parseString(true);
            }

            // revert to right after the quote but before any whitespace, and continue parsing the string
            output = output.substring(0, oBefore);
            i = iQuote + (entity ? entity.length : 1);

            // repair unescaped quote
            str = `${str.substring(0, oQuote)}\\${str.substring(oQuote)}`;
          } else if (stopAtDelimiter && isUnquotedStringDelimiter(text[i])) {
            // we're in the mode to stop the string at the first delimiter
            // because there is an end quote missing

            // test start of an url like "https://..." (this would be parsed as a comment)
            if (text[i - 1] === ':' && regexUrlStart.test(text.substring(iBefore + 1, i + 2))) {
              while (i < text.length && regexUrlChar.test(text[i])) {
                str += text[i];
                i++;
              }
            }

            // repair missing quote
            str = insertBeforeLastWhitespace(str, '"');
            output += str;
            parseConcatenatedString();
            return true;
          } else if (entity) {
            // decode an HTML entity inside the string as content
            const char = entity.char;
            if (char === '"') {
              // repair unescaped double quote
              str += '\\"';
            } else if (isControlCharacter(char)) {
              str += controlCharacters[char];
            } else {
              str += char;
            }
            i += entity.length;
          } else if (text[i] === '\\') {
            // handle escaped content like \n or \u2605
            const char = text.charAt(i + 1);
            const escapeChar = escapeCharacters[char];
            if (escapeChar !== undefined) {
              str += text.slice(i, i + 2);
              i += 2;
            } else if (char === 'u') {
              let j = 2;
              while (j < 6 && isHex(text[i + j])) {
                j++;
              }
              if (j === 6) {
                str += text.slice(i, i + 6);
                i += 6;
              } else if (i + j >= text.length) {
                // repair invalid or truncated unicode char at the end of the text
                // by removing the unicode char and ending the string here
                i = text.length;
              } else {
                throwInvalidUnicodeCharacter();
              }
            } else if (char === '\n') {
              // repair a backslash escaped newline (like in Bash scripts)
              str += '\\n';
              i += 2;
            } else {
              // repair invalid escape character: remove it
              str += char;
              i += 2;
            }
          } else {
            // handle regular characters
            const char = text.charAt(i);
            if (char === '"' && text[i - 1] !== '\\') {
              // repair unescaped double quote
              str += `\\${char}`;
              i++;
            } else if (isControlCharacter(char)) {
              // unescaped control character
              str += controlCharacters[char];
              i++;
            } else {
              if (!isValidStringCharacter(char)) {
                throwInvalidCharacter(char);
              }
              str += char;
              i++;
            }
          }
          if (skipEscapeChars) {
            // repair: skipped escape character (nothing to do)
            skipEscapeCharacter();
          }
        }
      }
      return false;
    }

    /**
     * Repair concatenated strings like "hello" + "world", change this into "helloworld"
     */
    function parseConcatenatedString() {
      let processed = false;
      parseWhitespaceAndSkipComments();
      while (text[i] === '+') {
        processed = true;
        i++;
        parseWhitespaceAndSkipComments();

        // repair: remove the end quote of the first string
        output = stripLastOccurrence(output, '"', true);
        const start = output.length;
        const parsedStr = parseString();
        if (parsedStr) {
          // repair: remove the start quote of the second string
          output = removeAtIndex(output, start, 1);
        } else {
          // repair: remove the + because it is not followed by a string
          output = insertBeforeLastWhitespace(output, '"');
        }
      }
      return processed;
    }

    /**
     * Parse a number like 2.4 or 2.4e6
     */
    function parseNumber() {
      const start = i;
      let num = '';
      let invalid = false;
      if (text[i] === '-') {
        num += text[i];
        i++;
        if (!isDigit(text[i]) && atEndOfNumber()) {
          // repair missing zero after minus like in "-.2" or "-"
          num += '0';
        }
      }
      if (text[i] === '0' && isDigit(text[i + 1])) {
        // the number has leading zeros like "00123" or "001.23"
        invalid = true;
      }
      while (isDigit(text[i])) {
        num += text[i];
        i++;
      }
      if (text[i] === '.') {
        if (num === '' || num === '-') {
          // repair missing leading zero before dot
          num += '0';
        }
        num += text[i];
        i++;
        if (!isDigit(text[i])) {
          // repair a truncated number like "2." into "2.0"
          num += '0';
        }
        while (isDigit(text[i])) {
          num += text[i];
          i++;
        }
      }
      if (i > start) {
        if (text[i] === 'e' || text[i] === 'E') {
          if (num === '-') {
            invalid = true;
          }
          num += text[i];
          i++;
          if (text[i] === '-' || text[i] === '+') {
            num += text[i];
            i++;
          }
          if (!isDigit(text[i])) {
            // repair a truncated number like "2e" into "2e0"
            num += '0';
          }
          while (isDigit(text[i])) {
            num += text[i];
            i++;
          }
        }

        // if we're not at the end of the number by this point, allow this to be parsed as another type
        if (!atEndOfNumber()) {
          i = start;
          return false;
        }
        output += invalid ? `"${text.substring(start, i)}"` : num;
        return true;
      }
      return false;
    }

    /**
     * Parse keywords true, false, null
     * Repair Python keywords True, False, None
     */
    function parseKeywords() {
      return parseKeyword('true', 'true') || parseKeyword('false', 'false') || parseKeyword('null', 'null') ||
      // repair Python keywords True, False, None
      parseKeyword('True', 'true') || parseKeyword('False', 'false') || parseKeyword('None', 'null');
    }
    function parseKeyword(name, value) {
      if (text.slice(i, i + name.length) === name && !isFunctionNameChar(text[i + name.length])) {
        output += value;
        i += name.length;
        return true;
      }
      return false;
    }

    /**
     * Repair an unquoted string by adding quotes around it
     * Repair a MongoDB function call like NumberLong("2")
     * Repair a JSONP function call like callback({...});
     */
    function parseUnquotedString(isKey) {
      // note that the symbol can end with whitespaces: we stop at the next delimiter
      // also, note that we allow strings to contain a slash / in order to support repairing regular expressions
      const start = i;
      if (isFunctionNameCharStart(text[i])) {
        while (i < text.length && isFunctionNameChar(text[i])) {
          i++;
        }
        let j = i;
        while (isWhitespace(text, j)) {
          j++;
        }
        if (text[j] === '(') {
          // repair a MongoDB function call like NumberLong("2")
          // repair a JSONP function call like callback({...});
          i = j + 1;
          parseValue();
          if (text[i] === ')') {
            // repair: skip close bracket of function call
            i++;
            if (text[i] === ';') {
              // repair: skip semicolon after JSONP call
              i++;
            }
          }
          return true;
        }
      }
      while (i < text.length && !isUnquotedStringDelimiter(text[i]) && !isQuote(text[i]) && (!isKey || text[i] !== ':')) {
        i++;
      }

      // test start of an url like "https://..." (this would be parsed as a comment)
      if (text[i - 1] === ':' && regexUrlStart.test(text.substring(start, i + 2))) {
        while (i < text.length && regexUrlChar.test(text[i])) {
          i++;
        }
      }
      if (i > start) {
        // repair unquoted string
        // also, repair undefined into null

        // first, go back to prevent getting trailing whitespaces in the string
        while (isWhitespace(text, i - 1) && i > 0) {
          i--;
        }
        const symbol = text.slice(start, i);
        output += symbol === 'undefined' ? 'null' : JSON.stringify(symbol);
        if (text[i] === '"') {
          // we had a missing start quote, but now we encountered the end quote, so we can skip that one
          i++;
        }
        return true;
      }
    }
    function parseRegex() {
      if (text[i] === '/') {
        const start = i;
        i++;
        while (i < text.length && (text[i] !== '/' || text[i - 1] === '\\')) {
          i++;
        }
        i++;
        output += JSON.stringify(text.substring(start, i));
        return true;
      }
    }
    function prevNonWhitespaceIndex(start) {
      let prev = start;
      while (prev > 0 && isWhitespace(text, prev)) {
        prev--;
      }
      return prev;
    }
    function nextQuoteIsEndQuote(index) {
      // precondition: text[index] is a quote. Peek past it: if nothing meaningful
      // follows, that quote is the true end and this one is embedded (e.g. `"The TV is 72""`)
      let next = index + 1;
      while (next < text.length && isWhitespace(text, next)) {
        next++;
      }
      return next >= text.length || isDelimiter(text[next]);
    }
    function atEndOfNumber() {
      return i >= text.length || isDelimiter(text[i]) || isWhitespace(text, i);
    }
    function throwInvalidCharacter(char) {
      throw new JSONRepairError(`Invalid character ${JSON.stringify(char)}`, i);
    }
    function throwUnexpectedCharacter() {
      throw new JSONRepairError(`Unexpected character ${JSON.stringify(text[i])}`, i);
    }
    function throwUnexpectedEnd() {
      throw new JSONRepairError('Unexpected end of json string', text.length);
    }
    function throwObjectKeyExpected() {
      throw new JSONRepairError('Object key expected', i);
    }
    function throwColonExpected() {
      throw new JSONRepairError('Colon expected', i);
    }
    function throwInvalidUnicodeCharacter() {
      const chars = text.slice(i, i + 6);
      throw new JSONRepairError(`Invalid unicode character "${chars}"`, i);
    }
  }
  function atEndOfBlockComment(text, i) {
    return text[i] === '*' && text[i + 1] === '/';
  }

  exports.JSONRepairError = JSONRepairError;
  exports.jsonrepair = jsonrepair;


  return exports;
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const ISSUES_DIR = path.join(DATA_DIR, 'issues');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const BLACKLIST_PATH = path.join(__dirname, 'ktv_blacklist.json');

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function citationUnits(text='') { const han=(String(text).match(/[\u3400-\u9fff]/g)||[]).length; const words=(String(text).replace(/[\u3400-\u9fff]/g,' ').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)||[]).length; return han/2+words; }

function getBeijingDateParts(customDate) {
  if (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
    const [y, m, d] = customDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const weekday = WEEKDAYS[dt.getUTCDay()];
    return {
      date: customDate,
      weekday,
      displayDate: `${y}年${m}月${d}日 ${weekday}`
    };
  }
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = cst.getUTCFullYear();
  const m = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cst.getUTCDate()).padStart(2, '0');
  const weekday = WEEKDAYS[cst.getUTCDay()];
  return {
    date: `${y}-${m}-${d}`,
    weekday,
    displayDate: `${y}年${Number(m)}月${Number(d)}日 ${weekday}`
  };
}

async function loadHistory() {
  const files = await fs.readdir(ISSUES_DIR).catch(() => []);
  const songKeys = new Set();
  const quoteTexts = new Set();
  const neigongTitles = [];
  const allTitles = [];

  for (const file of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
    const raw = await fs.readFile(path.join(ISSUES_DIR, file), 'utf8');
    const issue = JSON.parse(raw);
    for (const s of issue.songs || []) {
      songKeys.add(`${normalizeText(s.title)}::${normalizeText(s.artist)}`);
      allTitles.push(`${s.title} - ${s.artist}`);
    }
    for (const q of issue.quotes || []) {
      quoteTexts.add(normalizeText(q.text).slice(0, 24));
    }
    if (issue.neigong?.title) neigongTitles.push(issue.neigong.title);
  }
  return { songKeys, quoteTexts, neigongTitles, recentSongs: allTitles.slice(0, 400) };
}

async function fetchUserPreferences() {
  const url = process.env.FEEDBACK_API_URL;
  if (!url) return { likedEmotions: [], likedTechniques: [], blockedArtists: [], blockedTags: [] };

  try {
    const headers = {};
    if (process.env.FEEDBACK_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.FEEDBACK_API_TOKEN}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    const blockedArtists = (state.dislikes || [])
      .filter((d) => d.type === 'creator')
      .map((d) => d.value);
    const blockedTags = (state.dislikes || [])
      .filter((d) => d.type === 'content')
      .map((d) => d.value);
    return {
      likedEmotions: state.likedEmotions || [],
      likedTechniques: state.likedTechniques || [],
      blockedArtists,
      blockedTags
    };
  } catch (err) {
    console.warn('[preferences] 拉取云端偏好失败，回退默认均衡策略：', err.message);
    return { likedEmotions: [], likedTechniques: [], blockedArtists: [], blockedTags: [] };
  }
}

async function callGeminiJson(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('缺少环境变量 GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(240000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'low' }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API 错误 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed=JSON.parse(cleaned); }
  catch(error) {
    console.warn('[json] Repairing model output formatting:',error.message);
    parsed=JSON.parse(jsonrepair(cleaned));
  }
  if(!parsed || !Array.isArray(parsed.songs)) throw new Error('Gemini 返回缺少 songs 数组');
  return parsed;
}

function buildDailyPrompt({ dateInfo, history, blacklist, prefs }) {
  return `你是「灵感词库」的每日主编，请为 ${dateInfo.displayDate} 生成新一期内容，严格返回合法 JSON（不要 Markdown 包裹）。

【核心铁律】
1. 必须联网核验每一首歌词的真实原词，严禁凭记忆编造任何一句不存在的歌词；每首歌截取 2–3 个真实原词段落、共 8–14 行（约 10 行），中文摘录约 150–240 字符，外文摘录约 200–320 字符（外文 translations 数组与 lines 逐行一一对应、长度一致），严禁编造假词。其余写原创技法分析，reason 和内功文章不要额外引用歌词。附真实可打开的资料来源 URL。
2. 共 10 首歌：7 首中文 + 3 首外文（外文必须提供与 lines 一一对应的 translations 数组，长度严格一致）。
3. 中文选曲配比：
   - 港台流行顶级词作 3 首（林夕、黄伟文、葛大为、Hush、李焯雄、周耀辉等执笔的非 KTV 烂大街佳作）
   - 独立 / 摇滚 / 民谣 2 首
   - 近五年新人新作 2 首（如 deca joins、告五人、椅子乐团、老王乐队、洪佩瑜、LÜCY、傻子与白痴、单依纯等）
4. 硬排除清单（绝不可选）：${blacklist.blockedTitles.slice(0, 100).join('、')}
5. 历史已收录曲目（绝不可重复）：${history.recentSongs.slice(0, 120).join('；')}
6. 用户偏好约束：
   - 点赞偏好（最多倾斜 50% 席位，其余保留探索多样性）：情绪=${prefs.likedEmotions.join('、') || '无'}；技法=${prefs.likedTechniques.join('、') || '无'}
   - 严格屏蔽歌手/作者：${prefs.blockedArtists.join('、') || '无'}
   - 严格屏蔽技法/情绪：${prefs.blockedTags.join('、') || '无'}
7. 金句粮草库 20 条：以小说、散文、外国文学、纪实访谈、优质影视/网文为主（不要古诗词与现当代诗歌），每个作品只引用 1 条，单条中文最多 40 字、外文最多 25 个单词；每条标注双维度标签 emotion（情绪底色）与 technique（修辞/技法）。
8. 内功文章 1 篇：避开历史标题（${history.neigongTitles.slice(0, 30).join('、')}），聚焦一个具体作词技法，并与本期 2-3 首歌联动（在对应歌曲写入 neigongMatch: { note, highlightLines }）。

返回 JSON 结构：
{
  "date": "${dateInfo.date}",
  "weekday": "${dateInfo.weekday}",
  "displayDate": "${dateInfo.displayDate}",
  "issueLabel": "最新一期",
  "summary": "7 首中文 · 3 首外文附双语对照 · 20 条金句 · 1 篇内功",
  "neigong": {
    "date": "${dateInfo.date}",
    "title": "...",
    "coreTechnique": "...",
    "secondaryTechniques": ["...", "..."],
    "linkedSongIds": ["${dateInfo.date}-01", "${dateInfo.date}-02"],
    "excerpt": "...",
    "sections": [{ "heading": "...", "paragraphs": ["..."] }]
  },
  "songs": [
    {
      "id": "${dateInfo.date}-01",
      "index": "01",
      "title": "...",
      "artist": "...",
      "lyricist": "...",
      "language": "中文",
      "category": "港台流行顶级词作",
      "genreVertical": "六字内竖排流派",
      "emotion": "情绪底色",
      "technique": "修辞技法",
      "lines": ["..."],
      "translations": [],
      "reason": "1-2句编辑收录依据",
      "audio": { "youtubeId": "11位官方YouTube视频ID（若联网检索到则填，否则留空）", "previewUrl": "", "sources": [{"provider":"spotify 或 netease 或 qq 或 bandcamp","id":"联网检索到的真实曲目 ID；找不到则整个 sources 留空数组。Bandcamp 用 embed 字段填官方 EmbeddedPlayer URL"}] },
      "verification": { "status": "verified", "method": "联网核验", "sourceName": "...", "sourceUrl": "https://..." }
    }
  ],
  "quotes": [
    {
      "id": "${dateInfo.date}-q01",
      "index": "01",
      "category": "文学摘录",
      "emotion": "情绪底色",
      "technique": "修辞技法",
      "text": "≤40字短金句",
      "source": "作者 · 《作品名》"
    }
  ]
}`;
}

async function main() {
  const dateInfo = getBeijingDateParts(process.env.TARGET_DATE);
  const targetFile = path.join(ISSUES_DIR, `${dateInfo.date}.json`);

  try {
    await fs.access(targetFile);
    console.log(`[skip] ${dateInfo.date} 已存在，保持历史只增不改。`);
    return;
  } catch {
    // 继续生成当天期次
  }

  const blacklist = JSON.parse(await fs.readFile(BLACKLIST_PATH, 'utf8'));
  const history = await loadHistory();
  const prefs = await fetchUserPreferences();

  console.log(`[generate] 开始生成 ${dateInfo.displayDate} 期次...`);
  const draft = await callGeminiJson(buildDailyPrompt({ dateInfo, history, blacklist, prefs }));

  if(!Array.isArray(draft.quotes) || !draft.neigong?.title) throw new Error('Gemini 首轮返回不完整，缺少金句或内功');

  // 校验歌曲：黑名单 + 历史查重 + 屏蔽规则 + LRCLIB 原词核验
  const validSongs = [];
  const rejected = [];

  const attemptedKeys = new Set();
  let candidates = draft.songs || [];
  for (let round=0; round<3 && validSongs.length<10; round++) {
  for (const song of candidates) {
    if(validSongs.length>=10) break;
    const language = /外文|英文|英语|English|日文|日语|韩文|韩语|法文|法语|西班牙/i.test(String(song.language)) ? '外文' : '中文';
    song.language = language;
    if(validSongs.filter(s=>s.language===language).length >= (language==='外文'?3:7)) continue;
    const key = `${normalizeText(song.title)}::${normalizeText(song.artist)}`;
    if (attemptedKeys.has(key)) continue;
    attemptedKeys.add(key);
    const ktvCheck = isBlockedByKtvList(song.title, song.artist, blacklist);
    if (ktvCheck.blocked) {
      rejected.push({ song: song.title, reason: ktvCheck.reason });
      continue;
    }
    if (history.songKeys.has(key)) {
      rejected.push({ song: song.title, reason: '与历史期次重复' });
      continue;
    }
    if (prefs.blockedArtists.some((a) => normalizeText(a) === normalizeText(song.artist))) {
      rejected.push({ song: song.title, reason: '命中用户屏蔽歌手' });
      continue;
    }

    const quotedText = [...(song.lines || []), ...(song.translations || [])].join(' ');
    // removed citationUnits(quotedText) > 10 limit for 8-14 lines
    const verify = await verifySongWithLrclib(song);
    if (verify.ok) {
      song.verification = {
        status: 'verified',
        method: `${verify.sourceName}（命中 ${Math.round(verify.matchedRatio * 100)}%）`,
        sourceName: verify.sourceName,
        sourceUrl: verify.sourceUrl
      };
      const itunes = await resolveItunesPreview(song.title, song.artist);
      song.audio = {
        youtubeId: await resolveYoutubeId(song.audio?.youtubeId || ''),
        sources: await resolveAudioSources(song.title, song.artist, song.audio?.sources),
        previewUrl: itunes?.previewUrl || '',
        appleMusicUrl: itunes?.appleMusicUrl || ''
      };
      validSongs.push(song);
    } else {
      rejected.push({ song: `${song.title} - ${song.artist}`, reason: verify.reason });
    }
  }

  console.log(`[verify] 第 ${round+1} 轮累计通过 ${validSongs.length} 首；淘汰明细：`,rejected);
  if(validSongs.length<10 && round<2) {
    const missingChinese=7-validSongs.filter(s=>s.language==='中文').length;
    const missingForeign=3-validSongs.filter(s=>s.language==='外文').length;
    const refill = await callGeminiJson(buildDailyPrompt({dateInfo,history,blacklist,prefs})+`\n【补选轮次】已有 ${validSongs.length} 首核验通过。请只返回 {"songs":[...]}。本轮候选提供 ${Math.max(0,missingChinese*2)} 首中文和 ${Math.max(0,missingForeign*2)} 首外文，保持每首歌词、分析和标签字段完整。不要重复这些已尝试曲目：${[...attemptedKeys].join('、')}。上轮失败：${JSON.stringify(rejected)}。优先选官方词库可检索的真实原词。`);
    candidates=(refill.songs || []).map((song,i)=>({...song,id:`replacement-${round}-${i}`}));
  }
  }
  console.log(`[verify] 最终通过 ${validSongs.length} 首，淘汰 ${rejected.length} 首：`, rejected);

  if (validSongs.length < 10) {
    throw new Error(`三轮补选后仍未凑齐 10 首核验歌曲（仅 ${validSongs.length} 首），中止发布。`);
  }

  // 重新编号并过滤重复金句与超长金句
  const oldIds = validSongs.map(s=>s.id);
  draft.songs = validSongs.map((s, i) => ({
    ...s,
    id: `${dateInfo.date}-${String(i + 1).padStart(2, '0')}`,
    index: String(i + 1).padStart(2, '0')
  }));

  if (draft.neigong) {
    draft.neigong.date = dateInfo.date;
    draft.neigong.linkedSongIds = (draft.neigong.linkedSongIds || []).flatMap(id=>{const index=oldIds.indexOf(id);return index<0 ? [] : [draft.songs[index].id];});
  }
  draft.date = dateInfo.date;
  draft.displayDate = dateInfo.displayDate;

  draft.quotes = (draft.quotes || [])
    .filter((q) => q.text && q.text.length <= 100 && citationUnits(q.text) <= 25 && (q.text.match(/[\u3400-\u9fff]/g) || []).length <= 40 && !history.quoteTexts.has(normalizeText(q.text).slice(0, 24)))
    .slice(0, 20)
    .map((q, i) => ({
      ...q,
      id: `${dateInfo.date}-q${String(i + 1).padStart(2, '0')}`,
      index: String(i + 1).padStart(2, '0')
    }));

  draft.summary = `${draft.songs.length} 首核验短摘录 · ${draft.quotes.length} 条金句 · 1 篇内功`;

  await fs.writeFile(targetFile, JSON.stringify(draft, null, 2), 'utf8');

  // 更新 index.json
  const indexData = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  indexData.latest = dateInfo.date;
  indexData.updatedAt = new Date().toISOString();
  indexData.issues = [
    {
      date: dateInfo.date,
      displayDate: dateInfo.displayDate,
      neigongTitle: draft.neigong?.title || '',
      coreTechnique: draft.neigong?.coreTechnique || '',
      songCount: draft.songs.length,
      quoteCount: draft.quotes.length
    },
    ...(indexData.issues || []).filter((it) => it.date !== dateInfo.date)
  ];

  await fs.writeFile(INDEX_PATH, JSON.stringify(indexData, null, 2), 'utf8');
  console.log(`[done] 已写入 ${targetFile} 并更新 index.json`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
