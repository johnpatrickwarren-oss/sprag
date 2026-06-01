package ui

// Model is the central coordinator. INVARIANT (Tenets 1 & 2): it stays a THIN coordinator —
// per-view state lives in dedicated view structs, NOT here. Keep this struct small.
type Model struct {
	width    int
	height   int
	view     string
	views    map[string]View
	err      error
	quitting bool
}

// Row is a TYPED record (Tenet 4): never flatten rows to []string accessed by magic indices.
type Row struct {
	Name    string
	Alloc   int
	Compute int
}

// View owns its own behavior, so the coordinator never grows per-view branches.
type View interface {
	Update(msg Msg) View
	Rows() []Row
}

// Msg is a placeholder event type.
type Msg struct{}

// Update dispatches to the active view. INVARIANT (Tenet 2): the central per-view branching
// here does NOT grow — new views plug in via the View interface, not new cases.
func (m *Model) Update(msg Msg) {
	switch m.view {
	case "pods":
		m.views["pods"] = m.views["pods"].Update(msg)
	case "nodes":
		m.views["nodes"] = m.views["nodes"].Update(msg)
	}
}
