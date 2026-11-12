/**
 * Shared types. Every file under src/ is a classic script (no imports), so
 * these ambient declarations are visible everywhere.
 */

interface Selector {
  type: 'css' | 'xpath';
  value: string;
}

/**
 * One persisted edit, keyed (urlPattern, selector, property). `property` is
 * a CSS property name, '__html__' (outerHTML replacement — `value` is the
 * new markup), or '__remove__' (element deletion).
 */
interface ChangeRecord {
  id: string;
  urlPattern: string;
  timestamp: number;
  selector: string;
  selectorType: Selector['type'];
  property: string;
  value: string;
  /** CSS only: the property is switched off (applied as `revert`). */
  disabled?: boolean;
  /** CSS only: the record exists solely because an author property was unchecked. */
  authorDisable?: boolean;
  /** XPath CSS records are applied inline; the page's own inline value, for restoring. */
  inlinePrior?: string;
  /** __html__ / __remove__: the markup before the edit. */
  originalValue?: string;
  /** __remove__: where to re-insert the element. */
  parentSelector?: string;
  parentSelectorType?: Selector['type'];
  childIndex?: number;
  elementTag?: string | null;
  elementLabel?: string | null;
}

type ChangeInput = Omit<ChangeRecord, 'id' | 'urlPattern' | 'timestamp'>;

interface Snapshot {
  id: number;
  urlPattern: string;
  name: string;
  changes: ChangeRecord[];
  timestamp: number;
}

interface StyleProp {
  name: string;
  value: string;
  important: boolean;
}

interface MatchedRule {
  selector: string;
  /** State pseudos the rule needs (':hover', '::before'), or null if it applies as-is. */
  pseudo: string | null;
  source: string;
  properties: StyleProp[];
}

interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface BoxModel {
  content: { width: number; height: number };
  padding: Edges;
  border: Edges;
  margin: Edges;
}

interface ElementDescription {
  tag: string;
  id: string | null;
  classes: string[];
  attributes: { name: string; value: string }[];
}

interface TreeNode {
  selector: Selector;
  tag: string;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string }[];
  childCount: number;
  /** Text content, for leaf elements with a short text. */
  hasText: string | null;
}

interface ElementInfo {
  describe: ElementDescription;
  inline: { properties: StyleProp[] };
  matched: MatchedRule[];
  computed: Record<string, string>;
  box: BoxModel;
  /** Selectors of persisted CSS changes that match this element. */
  matchingChangeSelectors: string[];
  /** null when the subtree is too large to offer for editing. */
  outerHTML: string | null;
}

interface StyleEditPayload {
  selector: Selector;
  property: string;
  value: string;
  disabled?: boolean;
  authorDisable?: boolean;
  elementLabel?: string | null;
}

interface HtmlEditPayload {
  selector: Selector;
  value: string;
  originalValue: string;
  elementLabel?: string | null;
}

type Ok = { ok: boolean; error?: string };

/** Side panel → content script requests: payload and response per message type. */
interface RequestMap {
  START_PICKER: { req: {}; res: Ok };
  STOP_PICKER: { req: {}; res: Ok };
  GET_TREE_CHILDREN: { req: { selector: Selector | null }; res: { nodes: TreeNode[] } };
  GET_TREE_ANCESTORS: { req: { selector: Selector }; res: { ancestors: TreeNode[] } };
  HIGHLIGHT: { req: { selector: Selector }; res: Ok };
  UNHIGHLIGHT: { req: {}; res: Ok };
  SELECT: { req: { selector: Selector }; res: Ok };
  GET_ELEMENT_INFO: { req: { selector: Selector }; res: ElementInfo | null };
  APPLY_STYLE: { req: { payload: StyleEditPayload }; res: ChangeRecord };
  APPLY_HTML: { req: { payload: HtmlEditPayload }; res: { record: ChangeRecord; newSelector: Selector | null } };
  DELETE_ELEMENT: { req: { selector: Selector }; res: Ok };
  DUPLICATE_ELEMENT: { req: { selector: Selector }; res: Ok };
  FORCE_STATE: { req: { selector: Selector; states: string[] }; res: Ok };
  UNDO: { req: {}; res: { done: boolean } };
  REDO: { req: {}; res: { done: boolean } };
  GET_UNDO_STATE: { req: {}; res: UndoState };
  REVERT_CHANGE: { req: { id: string }; res: Ok };
  REVERT_PROP: { req: { selector: string; property: string }; res: Ok };
  REVERT_ALL: { req: {}; res: Ok };
  GET_CHANGES: { req: {}; res: { changes: ChangeRecord[] } };
  CREATE_SNAPSHOT: { req: { name: string }; res: { id: number } };
  GET_SNAPSHOTS: { req: {}; res: { snapshots: Snapshot[] } };
  DELETE_SNAPSHOT: { req: { id: number }; res: Ok };
  RESTORE_SNAPSHOT: { req: { id: number }; res: Ok };
}

type PanelRequest = { [K in keyof RequestMap]: { type: K } & RequestMap[K]['req'] }[keyof RequestMap];

interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

/** Content script (or service worker) → side panel pushes. */
type PanelPush =
  | { type: 'PICKER_STATE'; data: { active: boolean } }
  | { type: 'ELEMENT_SELECTED'; data: { selector: Selector | null } }
  | { type: 'CHANGES_LOADED'; data: { changes: ChangeRecord[] } }
  | { type: 'CHANGE_SAVED'; data: { id: string } }
  | { type: 'CHANGE_DELETED'; data: { id: string } }
  | { type: 'ALL_CLEARED'; data: {} }
  | { type: 'UNDO_STATE'; data: UndoState }
  | { type: 'HISTORY_APPLIED'; data: { direction: 'undo' | 'redo'; label: string } }
  | { type: 'REVERT_FAILED'; data: { id: string; reason: string } }
  | { type: 'URL_CHANGED'; url: string; tabId: number };

type ContentPush = Exclude<PanelPush, { type: 'URL_CHANGED' }>;
