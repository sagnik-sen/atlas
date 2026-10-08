import { createHash } from "node:crypto";
import { ts, SyntaxKind } from "ts-morph";

// Content-addressed ids (thesis §4.4), computed alongside the path-and-name entityId.
//
// Fingerprint = depth-first walk of the compiler AST under the declaration node.
// Per node we emit its SyntaxKind number; for identifiers and literals we also
// emit the token text; we close every node with ")" so the tree shape (not just
// the flat kind sequence) is hashed.
//
// Normalized (does not change the hash): whitespace, formatting, line breaks,
// comments and JSDoc (not AST children), semicolon/comma placement (tokens, not
// nodes), the file path, and the declaration's OWN name identifier (masked as
// "$name").
//
// NOT normalized: every other identifier and literal. Renaming a local
// variable, a parameter, or a call target inside the body CHANGES the hash, and
// so does renaming a recursive function's self-references (only the name node
// itself is masked). Body identifiers are kept because dropping them makes
// `() => a + b` and `() => c * d` differ only by operator kind and collapses
// far more entities. Members are hashed without their parent, so the owner
// class contributes nothing to structureId (contentId gets it via the
// qualified declared name).
//
// Entities that are not one of the declaration kinds below (SourceFile for
// `export * as ns`, object literals, modules, out-of-scope/external stubs) get
// no fingerprint.
const TEXT_KINDS = new Set<number>([
  SyntaxKind.Identifier, SyntaxKind.PrivateIdentifier, SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail, SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral, SyntaxKind.RegularExpressionLiteral,
]);

const FINGERPRINTABLE = new Set<number>([
  SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration,
  SyntaxKind.FunctionDeclaration, SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration, SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature, SyntaxKind.Constructor,
  SyntaxKind.GetAccessor, SyntaxKind.SetAccessor,
  SyntaxKind.PropertyDeclaration, SyntaxKind.PropertySignature,
  SyntaxKind.VariableDeclaration, SyntaxKind.Parameter,
  SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.BindingElement,
]);

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Returns null when the node is not fingerprintable; otherwise both ids.
export function fingerprint(node: any, declaredName: string):
    { structureId: string; contentId: string } | null {
  const cn: ts.Node | undefined = node?.compilerNode;
  if (!cn || !FINGERPRINTABLE.has(cn.kind)) return null;
  const nameNode: ts.Node | undefined = (cn as any).name;
  const parts: string[] = [];
  const walk = (n: ts.Node) => {
    if (n === nameNode) { parts.push("$name"); return; }
    parts.push(String(n.kind));
    if (TEXT_KINDS.has(n.kind)) parts.push(JSON.stringify((n as any).text));
    ts.forEachChild(n, walk);
    parts.push(")");
  };
  walk(cn);
  const structure = parts.join(" ");
  return {
    structureId: `struct:sha256:${h(structure)}`,
    contentId: `content:sha256:${h(JSON.stringify(declaredName) + "\0" + structure)}`,
  };
}
