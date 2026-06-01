// Model stays a THIN coordinator (Tenets 1 & 2): per-view state lives in view objects, not here.
export class Model {
  width = 0;
  height = 0;
  view = "";
  views: Record<string, View> = {};
  err: Error | null = null;
}

// Row is a TYPED record (Tenet 4): never flatten to string[] accessed by magic indices.
export interface Row {
  name: string;
  alloc: number;
  compute: number;
}

// Views own their behavior, so the coordinator never grows per-view branches.
export interface View {
  update(msg: Msg): View;
  rows(): Row[];
}
export interface Msg {}

// Dispatch stays BOUNDED (Tenet 2): new views plug in via the View interface, not new cases.
export function update(m: Model, msg: Msg): void {
  switch (m.view) {
    case "pods":
      m.views["pods"] = m.views["pods"].update(msg);
      break;
    case "nodes":
      m.views["nodes"] = m.views["nodes"].update(msg);
      break;
  }
}
