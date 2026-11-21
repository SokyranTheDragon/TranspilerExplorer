// Side-by-side diff rendering, moved over from the old script.js. Works on the fixed #code1/#code2 panes.
// Prism and Diff are globals from the vendored prism.js and diff.js.

import { $, $$, setLanguageClass } from "./dom.js";

const NON_TRAILING_NEWLINE = /\n(?!$)/g;
const LEADING_TABS = /^\t*/g;
const IL_LABEL = /IL_[0-9a-f]{4}/g;

// Last diff shown, so the line-height equalisation can be redone after a resize
let lastDiff = null;

export function setLanguage(isIL) {
    setLanguageClass($$(".code-pane pre, .code-pane code"), isIL);
}

/** Shows text in the panes without diffing (null leaves a side unchanged) */
export function setPlain(left, right) {
    lastDiff = null;
    $("#code1pre").dataset.line = "";
    $("#code2pre").dataset.line = "";
    if (left != null) $("#code1 code").textContent = left;
    if (right != null) $("#code2 code").textContent = right;
    highlight();
}

export function reset(text = "// Nothing selected") {
    setPlain(text, text);
}

function highlight() {
    for (const code of $$(".code-pane code")) Prism.highlightElement(code);
}

export function rerender() {
    if (lastDiff) diffAndSetCode(...lastDiff);
}

export function diffAndSetCode(code1, code2, ignoreIlLabels) {
    lastDiff = [code1, code2, ignoreIlLabels];

    code1 = code1.replaceAll("\r\n", "\n");
    code2 = code2.replaceAll("\r\n", "\n");

    var todiff = [code1, code2].map(c => c.split(NON_TRAILING_NEWLINE).map(l => l.replace(LEADING_TABS, "")).join("\n"));
    if (ignoreIlLabels)
        todiff = todiff.map(c => c.replaceAll(IL_LABEL, ""));

    var diff = customDiffLines(todiff[0], todiff[1], code1, code2);

    var codes = ["", ""];
    var curline = 0;
    var removed = "";
    var added = "";

    for (var i = 0; i < diff.length; i++) {
        var part = diff[i];

        // Removed and added parts overlap
        if (part.removed && diff[i + 1] && diff[i + 1].added) {
            var next = diff[i + 1];
            var d = part.count - next.count;

            codes[0] += part.values[0];
            codes[1] += next.values[1];

            for (var j = 0; j < Math.abs(d); j++) {
                if (d < 0) codes[0] += "\n";
                else codes[1] += '\n';
            }

            var p = curline;
            curline += Math.max(part.count, next.count);

            var short = p + Math.min(part.count, next.count);

            if (d > 0) {
                added += `${p + 1}-${short},${short + 1}-${short + Math.abs(d)},`;
                removed += `${p + 1}-${curline},`;
            } else {
                added += `${p + 1}-${curline},`;
                removed += `${p + 1}-${short},${short + 1}-${short + Math.abs(d)},`;
            }

            i++;
            continue;
        }

        if (part.added || part.removed) {
            if (part.added) {
                codes[1] += part.values[1];
                codes[0] += "\n".repeat(part.count);
            }
            else {
                codes[0] += part.values[0];
                codes[1] += "\n".repeat(part.count);
            }

            var p = curline;
            curline += part.count;
            added += `${p + 1}-${curline},`;
            removed += `${p + 1}-${curline},`;
        }
        else {
            codes[0] += part.values[0];
            codes[1] += part.values[1];
            curline += part.count;
        }
    }

    $("#code1 code").textContent = codes[0];
    $("#code1pre").dataset.line = removed;

    $("#code2 code").textContent = codes[1];
    $("#code2pre").dataset.line = added;

    highlight();

    var linesLeft = codes[0].split(NON_TRAILING_NEWLINE);
    var linesRight = codes[1].split(NON_TRAILING_NEWLINE);

    var oneLineHeight = lineNumbersGetOneLineHeight();
    var rowsLeft = $("#code1 .line-numbers-rows");
    var rowsRight = $("#code2 .line-numbers-rows");

    // Make line heights on both sides even (needs the panes visible, since wrapping depends on their width)
    if (rowsLeft && rowsRight && oneLineHeight > 0) {
        for (var i = 0; i < linesLeft.length; i++) {
            if (!rowsLeft.children[i] || !rowsRight.children[i]) break;

            var displayedLinesLeft = Math.round(parseFloat(rowsLeft.children[i].style.height) / oneLineHeight);
            var displayedLinesRight = Math.round(parseFloat(rowsRight.children[i].style.height) / oneLineHeight);

            // ​ is the zero-width space and ‌ is the zero-width non-joiner (a random z-w char different from the space)
            // ​\n is a marked newline, not treated as one by the Line Numbers plugin (edited to do so)
            // ‌ causes the (would-be-trailing) \n to not be omitted when calculating the line height
            if (displayedLinesLeft > displayedLinesRight) {
                linesRight[i] += "​\n‌".repeat(displayedLinesLeft - displayedLinesRight);
            } else if (displayedLinesRight > displayedLinesLeft) {
                linesLeft[i] += "​\n‌".repeat(displayedLinesRight - displayedLinesLeft);
            }
        }
    }

    $("#code1 code").textContent = linesLeft.join("\n");
    $("#code2 code").textContent = linesRight.join("\n");

    highlight();
}

function lineNumbersGetOneLineHeight() {
    var lineNumberSizer = $('#code1 .line-numbers-sizer');
    if (!lineNumberSizer) return 0;
    lineNumberSizer.innerHTML = '0';
    lineNumberSizer.style.display = 'block';
    var oneLineHeight = lineNumberSizer.getBoundingClientRect().height;
    lineNumberSizer.innerHTML = '';

    return oneLineHeight;
}

function customDiffLines(one, two, origOne, origTwo) {
    var result = Diff.diffLines(one, two);
    var curLines = [0, 0];
    var origLines = [origOne.split("\n"), origTwo.split("\n")];

    var handlePart = function (part, side) {
        part.values = ["", ""];

        for (var s of (side == 2 ? [0, 1] : [side])) {
            for (var k = 0; k < part.count; k++)
                part.values[s] += (origLines[s][curLines[s] + k] + "\n");

            curLines[s] += part.count;
        }
    }

    for (var part of result) {
        if (part.removed) {
            handlePart(part, 0);
        } else if (part.added) {
            handlePart(part, 1);
        } else {
            handlePart(part, 2);
        }
    }

    return result;
}
