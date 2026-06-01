package ui

// Model stays a THIN coordinator (Tenets 1 & 2).
type Model struct {
	width  int
	height int
	view   string
	views  map[string]View
	err    error
}

type View interface{ Update(msg Msg) View }
type Msg struct{}

// Background worker SENDS on a channel; it never mutates Model directly (Tenet 5: no data race).
func (m *Model) startWorker(bus chan Msg) {
	go func() {
		bus <- Msg{}
	}()
}

// Dispatch stays bounded (Tenet 2); rows stay typed (Tenet 4 — no magic indices).
func (m *Model) Update(msg Msg) {
	switch m.view {
	case "pods":
		m.views["pods"] = m.views["pods"].Update(msg)
	case "nodes":
		m.views["nodes"] = m.views["nodes"].Update(msg)
	}
}
