import type { Node, Tree } from 'web-tree-sitter';

import type { DeepLanguage } from './grammars';

/**
 * Reproduces `DriftTracker.extractItemSymbols`'s vocabulary from a parse tree.
 *
 * **The target is equality, not enrichment, and that is a safety property rather than
 * modesty.** `S_k = 1 - R_AST` for code, so a backend that adds *signature-level* symbols —
 * the kind body elision cannot destroy — lowers the drift score for the same transform and
 * moves files from refused to accepted. §59 measured that exact failure on Go: `type:Point`
 * and `import:fmt` survive body elision by construction, so a file with every function body
 * deleted scored `S_k = 0.0000` with `astMeasured: true` and both gates passing.
 *
 * So Deep emits the same six kinds the shipped extractor emits and no others:
 *
 *   fn:Name   type:Name   method:Name   method:Recv.Name   var:Name   import:Spec
 *
 * Where the two disagree, the disagreement is the measurement — it is read and classified,
 * not tuned away.
 */

const FIELD_NAME = 'name';

function named(node: Node, field: string): Node | null {
  return node.childForFieldName(field);
}

function walk(root: Node, visit: (node: Node, depth: number) => void): void {
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    visit(node, depth);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push({ node: child, depth: depth + 1 });
    }
  }
}

/**
 * Whether a declaration sits at the top level of the file.
 *
 * The shipped `var:` rule is `^(?:export\s+)?(?:const|let|var)\s+…` with the `m` flag —
 * anchored to column 0 because in TS and JS a top-level declaration *is* a column-0 one, and
 * an indented one is body content. §59's measurement is the reason: unanchored, every
 * `const i` inside a function body counted as a semantic symbol on par with an exported
 * function, and body elision is precisely the transform that removes them. One file reported
 * 42 of 63 symbols "lost" with 41 of them function-local and not one exported symbol gone.
 *
 * The tree answers the same question structurally, which is strictly better: it is not fooled
 * by a declaration that happens to start at column 0 inside a template literal.
 */
const TRANSPARENT_WRAPPERS = new Set([
  // `export const x = …` — still a top-level declaration.
  'export_statement',
  // Go nests the binding one level deeper than TS: `source_file > var_declaration > var_spec`.
  // Missing these cost `var:Origin` on the first draft, which a test using a var-free Go
  // source did not notice.
  'var_declaration',
  'const_declaration',
]);

function isTopLevel(node: Node, rootType: string): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === rootType) return true;
    if (!TRANSPARENT_WRAPPERS.has(parent.type)) return false;
    parent = parent.parent;
  }
  return false;
}

/** Strips the quotes from a string literal node's text. */
function literalText(node: Node): string {
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Whether a Go spec sits on the same line as the keyword that introduces it.
 *
 * **This is the discriminator for Go's grouped declaration blocks, and it is a faithful mirror
 * of what the shipped regexes can see rather than a heuristic.** Every shipped rule needs the
 * keyword and the name adjacent — `(?:class|interface|type|enum|struct)\s+(\w+)` for types,
 * `^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=` for bindings, and the import rule likewise. A
 * grouped block puts `(` where the name would be and indents the entries onto later lines, so
 * the shipped extractor harvests **nothing** from it:
 *
 *     const Single = 1        const_declaration row 7, const_spec row 7   -> both see it
 *     const (                 const_declaration row 2
 *         TypeReg = '0'       const_spec        row 3                     -> only Deep sees it
 *     )
 *
 * Measured over the frozen 80-file Go corpus, emitting them anyway produced **142 extra
 * symbols** — 122 `var:` from grouped `const (…)` blocks and 20 `type:` from grouped `type (…)`
 * blocks. Every one is a **top-level declaration, which no region `selectElisionRegions` selects
 * ever touches**, so all 142 are retained by construction: adding them to both the before and
 * after sets raises `R_AST` toward 1 and *lowers* `S_k` for the same transform. That is §59's
 * hazard, and Go is the language §59 found it on.
 *
 * So Deep reproduces the blindness. Fixing it is a deliberate, separately measured change and
 * belongs to R4, not to a release whose constraint is no reduction change.
 */
function onKeywordLine(spec: Node): boolean {
  const declaration = spec.parent;
  return declaration !== null && declaration.startPosition.row === spec.startPosition.row;
}

/**
 * The modifiers the shipped `method:` regex requires.
 *
 * Block 8 of `extractItemSymbols` matches
 * `(?:public|private|protected|async|static|get|set)\s+(\w+)\s*\(`, so a class method with no
 * modifier — `area(): number {}` — yields **no** symbol. That is a quirk of a regex that
 * needed an anchor, not a decision about what a method is, but reproducing it is what keeps
 * the two extractors comparable. Widening it here would register as a Deep "improvement" that
 * is really a silent change to every drift denominator.
 */
const METHOD_MODIFIERS = new Set(['public', 'private', 'protected', 'async', 'static', 'get', 'set']);

function hasRequiredModifier(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'accessibility_modifier' || METHOD_MODIFIERS.has(child.type)) return true;
  }
  return false;
}

export function symbolsFromTree(tree: Tree, language: DeepLanguage): Set<string> {
  const symbols = new Set<string>();
  const fnNames = new Set<string>();
  const root = tree.rootNode;

  // Two passes, because the shipped extractor's `method:` rule consults `fnNames`, which its
  // earlier blocks fill. Collecting function names first reproduces that ordering without
  // depending on traversal order.
  walk(root, (node) => {
    if (
      node.type === 'function_declaration' ||
      node.type === 'generator_function_declaration' ||
      node.type === 'function_definition'
    ) {
      const name = named(node, FIELD_NAME);
      if (name) fnNames.add(name.text);
    }
  });

  walk(root, (node) => {
    switch (node.type) {
      // --- functions -------------------------------------------------------------------
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_definition': {
        const name = named(node, FIELD_NAME);
        if (name) symbols.add(`fn:${name.text}`);
        break;
      }

      // --- Go methods, qualified by receiver ---------------------------------------------
      // §59: Go convention gives many types in one file the same method names — `String`,
      // `Error`, `Read` — so a bare `method:String` collapses all of them into one symbol and
      // losing ten would read as losing one.
      case 'method_declaration': {
        const name = named(node, FIELD_NAME);
        const receiver = named(node, 'receiver');
        if (name && receiver) {
          const typeNode =
            receiver.descendantsOfType('type_identifier')[0] ?? receiver.descendantsOfType('identifier')[1];
          if (typeNode) symbols.add(`method:${typeNode.text}.${name.text}`);
        }
        break;
      }

      // --- TS/JS class methods ------------------------------------------------------------
      case 'method_definition': {
        const name = named(node, FIELD_NAME);
        if (name && hasRequiredModifier(node) && !fnNames.has(name.text)) {
          symbols.add(`method:${name.text}`);
        }
        break;
      }

      // --- types ----------------------------------------------------------------------
      case 'class_declaration':
      case 'class_definition':
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = named(node, FIELD_NAME);
        if (name) symbols.add(`type:${name.text}`);
        break;
      }
      case 'type_spec': {
        // Go: `type Circle struct { … }`. Skipped inside a grouped `type ( … )` block.
        if (!onKeywordLine(node)) break;
        const name = named(node, FIELD_NAME);
        if (name) symbols.add(`type:${name.text}`);
        break;
      }

      // --- top-level bindings with an initializer ---------------------------------------
      case 'lexical_declaration':
      case 'variable_declaration': {
        if (!isTopLevel(node, root.type)) break;
        for (const declarator of node.descendantsOfType('variable_declarator')) {
          const name = named(declarator, FIELD_NAME);
          // The shipped regex requires `=`; a bare `let x;` yields nothing.
          if (!name || !named(declarator, 'value')) continue;
          // **An annotated declaration is skipped, reproducing a shipped limitation.**
          // `^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=` needs the `=`
          // immediately after the name, so `const X: Readonly<Record<…>> = {` does not match
          // and the shipped extractor emits nothing for it. Measured over the frozen corpus
          // this is **20 of this repository's own module constants** — `DEFAULT_TOKENIZER`,
          // `TOOL_DEFINITIONS`, `SUPPORTED_FLAGS` and the rest.
          //
          // Deep finding them is more correct and is still refused, for the reason the
          // grouped-import case above gives: a top-level `const` is not inside any region
          // `selectElisionRegions` selects, so it is retained by construction, and a retained
          // symbol added to both sides raises `R_AST` and *lowers* `S_k`. Recorded for R4,
          // where changing it is a deliberate, separately measured move.
          if (named(declarator, 'type')) continue;
          symbols.add(`var:${name.text}`);
        }
        break;
      }
      case 'var_spec':
      case 'const_spec': {
        // Go. The shipped regex reaches these through the same `const|let|var` alternation,
        // and equally requires an `=`.
        if (!isTopLevel(node, root.type) || !onKeywordLine(node)) break;
        const name = named(node, FIELD_NAME);
        if (!name || !named(node, 'value')) break;
        // Annotated, so the shipped regex cannot reach the `=` — the same rule as the TS
        // declarator above. On Go this is the typed blank-identifier assertion,
        // `var _ Interface = (*T)(nil)`, which was the last 3 extras on the 80-file corpus.
        if (named(node, 'type')) break;
        symbols.add(`var:${name.text}`);
        break;
      }

      // --- imports ----------------------------------------------------------------------
      case 'import_statement': {
        // TS/JS carry a quoted source; Python carries dotted names.
        const source = named(node, 'source');
        if (source) {
          symbols.add(`import:${literalText(source)}`);
          break;
        }
        for (const child of node.namedChildren) {
          if (!child) continue;
          if (child.type === 'dotted_name') symbols.add(`import:${child.text}`);
          if (child.type === 'aliased_import') {
            const mod = named(child, FIELD_NAME) ?? child.namedChild(0);
            if (mod) symbols.add(`import:${mod.text}`);
          }
        }
        break;
      }
      case 'import_from_statement': {
        const mod = named(node, 'module_name');
        if (mod) symbols.add(`import:${mod.text}`);
        break;
      }
      case 'future_import_statement': {
        // `from __future__ import annotations` is its own node type in the Python grammar, and
        // it carries **no `module_name` field** — the module is implicit in the node. Missing
        // this dropped `import:__future__`, a symbol the shipped extractor does find, on every
        // pip file that opens with it. A lost real symbol *raises* drift rather than lowering
        // it, so it fails safe, but it is still the backend disagreeing with itself about what
        // an import is.
        symbols.add('import:__future__');
        break;
      }
      case 'import_spec': {
        // Go. **A grouped `import ( … )` block is deliberately skipped**, which is Deep
        // reproducing a limitation of the shipped extractor rather than a gap in the grammar.
        //
        // `jsImportRegex` is `import\s+(?:…from\s+)?['"]([^'"]+)['"]` — after `import` it
        // needs a quote or a from-clause, and a grouped block puts `(` there. So the shipped
        // extractor sees `import:math` for `import "math"` and **nothing** for the same
        // import written in a group.
        //
        // Emitting them would be more correct and is refused here anyway, because `import:`
        // is signature-level: it survives body elision by construction, so adding it to both
        // the before and after sets raises `R_AST` toward 1 and *lowers* `S_k` for the same
        // transform. Measured on this repository's own control file, deep retention went to
        // 0.6 against the shipped 0.5 — §59's falling drift score, which step 1 exists to
        // refuse. R3's constraint is no reduction change; fixing the shipped extractor is a
        // deliberate, separately measured change and belongs to R4.
        if (!onKeywordLine(node)) break;
        const path = named(node, 'path') ?? node.namedChildren.find((c) => c?.type.includes('string'));
        if (path) symbols.add(`import:${literalText(path)}`);
        break;
      }
      case 'interpreted_string_literal': {
        // A bare `import "math"` puts the literal directly under `import_declaration` in some
        // grammar versions rather than wrapping it in an `import_spec`.
        if (node.parent?.type === 'import_declaration') symbols.add(`import:${literalText(node)}`);
        break;
      }

      default:
        break;
    }
  });

  return symbols;
}
