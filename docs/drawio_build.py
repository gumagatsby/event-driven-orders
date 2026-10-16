"""Generate the .drawio diagrams for this repo (C4 container style)."""
import sys
from html import escape

OUTDIR = sys.argv[1]

C = {"storage": "#7AA116", "integration": "#E7157B", "compute": "#ED7100", "database": "#C925D1",
     "analytics": "#8C4FFF", "management": "#E7157B", "security": "#DD344C", "cost": "#7AA116"}
INK = "#232F3E"
EDGE = "#545B64"
RED = "#D13212"


class Doc:
    def __init__(self, name, w, h):
        self.name, self.w, self.h = name, w, h
        self.cells = []
        self.n = 2
        self.org = {"1": (0, 0)}  # absolute origin of each container; all coordinates passed in are absolute

    def _id(self):
        self.n += 1
        return f"c{self.n}"

    def add(self, value, style, x, y, w, h, parent="1", vertex=True):
        i = self._id()
        value = value.replace("\n", "<br>")
        self.org[i] = (x, y)
        px, py = self.org[parent]
        x, y = x - px, y - py
        self.cells.append(
            f'<mxCell id="{i}" value="{escape(value)}" style="{style}" vertex="1" parent="{parent}">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return i

    def group(self, label, kind, x, y, w, h, parent="1", fs=12):
        styles = {
            "cloud": f"grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor={INK};fontColor={INK};dashed=0;",
            "region": "grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fontColor=#147EBA;dashed=1;",
            "account": "grIcon=mxgraph.aws4.group_account;strokeColor=#CD2264;fontColor=#CD2264;dashed=0;",
            "office": f"grIcon=mxgraph.aws4.group_corporate_data_center;strokeColor=#7D8998;fontColor={INK};dashed=0;",
            "vpc": "grIcon=mxgraph.aws4.group_vpc;strokeColor=#8C4FFF;fontColor=#8C4FFF;dashed=0;",
            "vpc_off": "grIcon=mxgraph.aws4.group_vpc;strokeColor=#8C4FFF;fontColor=#8C4FFF;dashed=1;",
            "public": "grIcon=mxgraph.aws4.group_security_group;strokeColor=#7AA116;fontColor=#248814;dashed=0;",
            "private": "grIcon=mxgraph.aws4.group_security_group;strokeColor=#00A4A6;fontColor=#147EBA;dashed=0;",
        }
        st = ("points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=%d;fontStyle=1;"
              "container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;"
              "fillColor=none;verticalAlign=top;align=left;spacingLeft=30;" % fs) + styles[kind]
        return self.add(label, st, x, y, w, h, parent)

    def box(self, label, x, y, w, h, parent="1", color="#879196", fs=12):
        st = (f"fillColor=none;strokeColor={color};dashed=1;verticalAlign=top;fontStyle=1;fontColor={color};"
              f"whiteSpace=wrap;html=1;align=left;spacingLeft=10;spacingTop=4;fontSize={fs};rounded=1;arcSize=3;container=1;collapsible=0;")
        return self.add(label, st, x, y, w, h, parent)

    @staticmethod
    def lab(pos):
        return {"below": "verticalLabelPosition=bottom;verticalAlign=top;align=center;",
                "above": "verticalLabelPosition=top;verticalAlign=bottom;align=center;",
                "right": "labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;spacingLeft=4;",
                "left": "labelPosition=left;verticalLabelPosition=middle;align=right;verticalAlign=middle;spacingRight=4;"}[pos]

    def res(self, label, icon, cat, x, y, parent="1", s=64, fs=12, pos="below"):
        st = (f"sketch=0;outlineConnect=0;fontColor={INK};gradientColor=none;fillColor={C[cat]};strokeColor=#ffffff;"
              f"dashed=0;html=1;fontSize={fs};" + self.lab(pos) +
              f"aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{icon};")
        return self.add(label, st, x, y, s, s, parent)

    def shape(self, label, shp, color, x, y, w=52, h=52, parent="1", fs=12, pos="below"):
        st = (f"sketch=0;outlineConnect=0;fontColor={INK};gradientColor=none;fillColor={color};strokeColor=none;"
              f"dashed=0;html=1;fontSize={fs};" + self.lab(pos) +
              f"aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.{shp};")
        return self.add(label, st, x, y, w, h, parent)

    def text(self, label, x, y, w, h, fs=12, bold=False, color=INK, align="left", parent="1"):
        st = (f"text;html=1;strokeColor=none;fillColor=none;align={align};verticalAlign=top;whiteSpace=wrap;"
              f"fontSize={fs};fontColor={color};fontStyle={1 if bold else 0};")
        return self.add(label, st, x, y, w, h, parent)

    def badge(self, n, x, y, parent="1", d=24, fs=12):
        st = (f"ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor={INK};strokeColor=none;fontColor=#FFFFFF;"
              f"fontStyle=1;fontSize={fs};")
        return self.add(str(n), st, x, y, d, d, parent)

    def _raw(self, html, st, x, y, w, h):
        i = self._id()
        self.org[i] = (x, y)
        self.cells.append(f'<mxCell id="{i}" value="{escape(html)}" style="{st}" vertex="1" parent="1">'
                          f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return i

    @staticmethod
    def _label(title, tech, desc, fs):
        return (f"<b>{escape(title)}</b><br><span style='color:#545B64'>[{escape(tech)}]</span>"
                + (f"<br><span style='font-size:{fs - 1}px'>{escape(desc)}</span>" if desc else ""))

    def node(self, title, tech, desc, x, y, w=210, h=96, stroke=INK, dashed=False, fs=12):
        """C4 container: name, [technology], one-line purpose. White fill, 1px border."""
        st = (f"rounded=1;arcSize=6;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor={stroke};strokeWidth=1;"
              f"fontColor={INK};fontSize={fs};verticalAlign=middle;spacing=8;" + ("dashed=1;" if dashed else ""))
        return self._raw(self._label(title, tech, desc, fs), st, x, y, w, h)

    def db(self, title, tech, desc, x, y, w=170, h=100, fs=12):
        st = (f"shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#FFFFFF;strokeColor={INK};"
              f"strokeWidth=1;fontColor={INK};fontSize={fs};")
        return self._raw(self._label(title, tech, desc, fs), st, x, y, w, h)

    def person(self, label, x, y, fs=12):
        st = (f"shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;"
              f"fillColor=#FFFFFF;strokeColor={INK};fontColor={INK};fontSize={fs};")
        return self.add(label, st, x, y, 30, 56)

    def boundary(self, label, x, y, w, h):
        st = ("rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#879196;dashed=1;dashPattern=8 4;"
              "verticalAlign=bottom;align=left;spacingLeft=10;spacingBottom=6;fontColor=#545B64;fontSize=12;fontStyle=1;")
        return self.add(label, st, x, y, w, h)

    def edge(self, src, dst, label="", color=EDGE, dashed=False, w=1.5, ex=None, ey=None, nx=None, ny=None, fs=11, via=None, both=False):
        i = self._id()
        st = (f"edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor={color};"
              + ("startArrow=block;startFill=1;" if both else "")
              + f"strokeWidth={w};fontSize={fs};fontColor={INK};labelBackgroundColor=#FFFFFF;"
              + ("dashed=1;dashPattern=6 4;" if dashed else ""))
        if ex is not None: st += f"exitX={ex};exitY={ey};exitDx=0;exitDy=0;"
        if nx is not None: st += f"entryX={nx};entryY={ny};entryDx=0;entryDy=0;"
        self.cells.append(
            f'<mxCell id="{i}" value="{escape(label.replace(chr(10), "<br>"))}" style="{st}" edge="1" parent="1" source="{src}" target="{dst}">'
            f'<mxGeometry relative="1" as="geometry">'
            + ('<Array as="points">' + "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in via) + '</Array>' if via else "")
            + '</mxGeometry></mxCell>')
        return i

    def line(self, x1, y1, x2, y2, label="", dashed=False, color=EDGE, arrow=True, fs=11):
        i = self._id()
        st = (f"html=1;endArrow={'block' if arrow else 'none'};endFill=1;strokeColor={color};strokeWidth=1.5;fontSize={fs};"
              f"fontColor={INK};labelBackgroundColor=#FFFFFF;" + ("dashed=1;dashPattern=6 4;" if dashed else ""))
        self.cells.append(
            f'<mxCell id="{i}" value="{escape(label)}" style="{st}" edge="1" parent="1">'
            f'<mxGeometry relative="1" as="geometry"><mxPoint x="{x1}" y="{y1}" as="sourcePoint"/>'
            f'<mxPoint x="{x2}" y="{y2}" as="targetPoint"/></mxGeometry></mxCell>')

    def xml(self):
        return (f'<mxfile host="drawio"><diagram name="{escape(self.name)}">'
                f'<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
                f'fold="1" page="1" pageScale="1" pageWidth="{self.w}" pageHeight="{self.h}" background="#FFFFFF" math="0" shadow="0">'
                '<root><mxCell id="0"/><mxCell id="1" parent="0"/>'
                + "".join(self.cells) + "</root></mxGraphModel></diagram></mxfile>")



GREY = "#879196"
SUB = "#545B64"

# =====================================================================
# 1. Container diagram (C4 level 2)
# =====================================================================
d = Doc("Event-driven orders: containers", 1760, 900)
d.add("", "rounded=0;fillColor=#FFFFFF;strokeColor=none;", 0, 0, 1760, 900)
d.text("Event-driven order system", 30, 20, 900, 34, fs=24, bold=True)
d.text("Container diagram (C4 level 2)", 30, 56, 900, 22, fs=14, color=SUB)

client = d.person("Customer's app\n(places and tracks orders)", 64, 262)

d.boundary("Kubernetes cluster (kind), installed with Helm", 200, 110, 1000, 690)
orders = d.node("Orders service", "TypeScript, NestJS, 2 replicas",
                "REST API: takes orders idempotently, tracks status, publishes events through an outbox",
                260, 220, 260, 120)
inv = d.node("Inventory service", "Java 21, Spring Boot, 2 replicas",
             "Answers stock queries over gRPC; reserves and releases stock, each event exactly once",
             820, 220, 260, 120)
kafka = d.node("Event broker", "Apache Kafka 4.3, KRaft",
               "orders.events and inventory.events, keyed by order id; a dead-letter topic for each",
               540, 400, 220, 130)
odb = d.db("Orders database", "PostgreSQL 17", "Orders, lines, outbox, processed events", 210, 620, 190, 120)
idb = d.db("Inventory database", "PostgreSQL 17", "Products, reservations, outbox, processed events", 960, 620, 190, 120)
jaeger = d.node("Tracing", "Jaeger, OpenTelemetry", "Both services export traces; one trace follows an order end to end",
                540, 640, 220, 100, stroke=GREY)

d.edge(client, orders, "Places orders\n[REST, Idempotency-Key]", nx=0, ny=0.5)
d.edge(orders, inv, "Checks availability\n[gRPC, 300 ms deadline]", ex=1, ey=0.3, nx=0, ny=0.3)
d.edge(orders, kafka, "OrderPlaced,\nOrderCancelled", ex=0.75, ey=1, nx=0, ny=0.3, via=[(455, 439)])
d.edge(kafka, orders, "StockReserved,\nRejected, Released", ex=0, ey=0.75, nx=0.25, ny=1, via=[(325, 497)])
d.edge(kafka, inv, "Order events", ex=1, ey=0.3, nx=0.25, ny=1, via=[(885, 439)])
d.edge(inv, kafka, "Stock results", ex=0.75, ey=1, nx=1, ny=0.75, via=[(1015, 497)])
d.edge(orders, odb, "SQL", ex=0.1, ey=1, nx=0.4, ny=0)
d.edge(inv, idb, "SQL", ex=0.9, ey=1, nx=0.49, ny=0)

lx = 1260
d.text("What it guarantees", lx, 120, 460, 22, fs=15, bold=True)
g = [
    "No order is lost: it is saved with its event in one transaction (outbox), so Kafka and inventory can both be down.",
    "Stock is never oversold: rows are locked in SKU order, and a CHECK constraint backs it up.",
    "Each event takes effect once: its id is recorded in the same transaction as its effect.",
    "Each order's events are handled in order: one partition per order id, one relay publishing at a time.",
    "A malformed message goes to a dead-letter topic instead of blocking everything behind it.",
]
y = 152
for s_ in g:
    d.text(s_, lx, y, 460, 50, fs=12)
    y += 54
d.text("Measured on the cluster", lx, y + 6, 460, 20, fs=13, bold=True)
d.text("40 orders for 10 monitors: exactly 10 confirmed.\n"
       "Inventory down: 20 of 20 orders accepted, all confirmed 15 s after it returned.\n"
       "Kafka down: 20 of 20 accepted, all confirmed 34 s after it returned.\n"
       "Accepted to confirmed: p50 232 ms, p95 360 ms.", lx, y + 28, 460, 90, fs=12)
d.text("Legend", lx, 760, 460, 20, fs=13, bold=True)
d.text("Solid: requests and events\nGrey border: observability", lx, 782, 460, 40, fs=12, color=SUB)
open(f"{OUTDIR}/architecture.drawio", "w").write(d.xml())

# =====================================================================
# 2. Order flow sequence
# =====================================================================
s = Doc("Order flow", 1560, 1080)
s.add("", "rounded=0;fillColor=#FFFFFF;strokeColor=none;", 0, 0, 1560, 1080)
s.text("Placing an order", 30, 20, 900, 34, fs=24, bold=True)
s.text("Accepted at once, decided asynchronously: an outbox on each side, each event applied exactly once",
       30, 56, 1300, 22, fs=14, color=SUB)
lanes = [("Client", "customer's app"), ("Orders", "NestJS"), ("Orders DB", "PostgreSQL"),
         ("Kafka", "broker"), ("Inventory", "Spring Boot"), ("Inventory DB", "PostgreSQL")]
X = [120, 360, 600, 840, 1090, 1360]
for (n, t), x in zip(lanes, X):
    s._raw(Doc._label(n, t, "", 12), f"rounded=1;arcSize=8;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor={INK};"
           f"fontColor={INK};fontSize=12;", x - 85, 100, 170, 56)
    # A shape, not a connector, so it stays behind the text drawn after it.
    s.add("", f"line;strokeWidth=1.5;direction=south;html=1;dashed=1;dashPattern=6 4;strokeColor={GREY};",
          x - 5, 156, 10, 884)


def msg(a, b, y, text_, dashed=False, n=None, h=42):
    """Arrow with its label above it, after the step number, so the label never covers the arrow."""
    s.line(X[a], y, X[b], y, "", dashed=dashed)
    left = min(X[a], X[b])
    span = abs(X[b] - X[a])
    if n:
        s.badge(n, left + 8, y - 25, d=20, fs=10)
    w = min(span - 40, fit(text_, 11))
    lines = -(-fit(text_, 11) // w)
    h = lines * 15 + 1
    s.add(text_, f"text;html=1;strokeColor=none;fillColor=#FFFFFF;align=left;verticalAlign=bottom;whiteSpace=wrap;"
             f"fontSize=11;fontColor={INK};spacing=0;autosize=0;", left + 34, y - 5 - h, w, h)


# Text boxes are filled white and sized to their text, so a lifeline passes
# behind the words instead of through them.
def fit(text_, fs, bold=False):
    return int(len(text_) * fs * (0.6 if bold else 0.55)) + 6


def note(x, y, w, text_, h=18):
    s.add(text_, f"text;html=1;strokeColor=none;fillColor=#FFFFFF;align=left;verticalAlign=top;whiteSpace=wrap;"
             f"fontSize=11;fontColor={SUB};spacing=0;", x, y, min(w, fit(text_, 11)), h)


def section(y, text_):
    s.add(text_, f"text;html=1;strokeColor=none;fillColor=#FFFFFF;align=left;verticalAlign=top;whiteSpace=wrap;"
             f"fontSize=12;fontStyle=1;fontColor={INK};spacing=0;", 20, y, fit(text_, 12, True), 18)


msg(0, 1, 210, "POST /orders [Idempotency-Key]", n=1)
msg(1, 4, 270, "CheckAvailability [gRPC, 300 ms deadline]", n=2)
note(386, 280, 420, "Advisory. Short stock: 422 at once. Inventory unreachable: accept anyway.")
msg(1, 2, 360, "BEGIN; INSERT order (PENDING), lines, outbox row OrderPlaced; COMMIT", n=3)
msg(1, 0, 410, "202 Accepted, Location: /orders/{id}", dashed=True, n=4)
section(440, "Outbox relay in orders, every 200 ms")
msg(1, 3, 500, "Publish OrderPlaced [key = order id]", n=5)
msg(1, 2, 560, "Mark published, only after Kafka acknowledges", n=6)
section(590, "Inventory consumer")
msg(3, 4, 650, "Deliver OrderPlaced", n=7)
msg(4, 5, 740, "BEGIN; record event id (skip if seen); lock products in SKU order; reserve; "
               "INSERT outbox row StockReserved; COMMIT", n=8, h=56)
note(1116, 750, 400, "Short stock: StockRejected with the reason, nothing reserved")
msg(4, 3, 830, "Publish StockReserved [same key] via inventory's outbox relay", n=9)
section(860, "Orders consumer")
msg(3, 1, 920, "Deliver StockReserved", n=10)
msg(1, 2, 990, "Record event id; PENDING to CONFIRMED (only if still PENDING)", n=11)
note(386, 1000, 520, "A cancelled order stays cancelled; inventory releases its stock on OrderCancelled.")
open(f"{OUTDIR}/order-flow.drawio", "w").write(s.xml())

# =====================================================================
# 3. LinkedIn: 540x675 page, exported at 2x = 1080x1350
# =====================================================================
L = Doc("LinkedIn", 540, 675)
L.add("", "rounded=0;fillColor=#FFFFFF;strokeColor=none;", 0, 0, 540, 675)
L.text("Event-driven order system", 22, 20, 500, 30, fs=22, bold=True)
L.text("TypeScript, Java, Kafka, gRPC, Kubernetes, Helm", 22, 52, 500, 20, fs=13, color=SUB)
lo = L.node("Orders", "TypeScript, NestJS", "", 22, 110, 136, 56, fs=11)
lk = L.node("Kafka", "events by order id", "", 202, 110, 136, 56, fs=11)
li = L.node("Inventory", "Java, Spring Boot", "", 382, 110, 136, 56, fs=11)
lod = L.db("Orders DB", "PostgreSQL", "", 27, 200, 126, 64, fs=11)
lid = L.db("Inventory DB", "PostgreSQL", "", 387, 200, 126, 64, fs=11)
L.edge(lo, lk, both=True)
L.edge(lk, li, both=True)
L.edge(lo, li, "gRPC", ex=0.5, ey=0, nx=0.5, ny=0, via=[(90, 92), (450, 92)], fs=10)
L.edge(lo, lod)
L.edge(li, lid)
L.text("What it guarantees", 22, 300, 500, 20, fs=13, bold=True)
items = ["No order is lost, even with Kafka or inventory down", "Stock is never oversold",
         "Each event takes effect exactly once, in order", "Bad messages go to a dead-letter topic"]
for n, s_ in enumerate(items):
    L.text(s_, 22, 326 + n * 22, 500, 20, fs=12)
L.text("Measured on a 3-node Kubernetes cluster", 22, 430, 500, 20, fs=13, bold=True)
for n, s_ in enumerate(["40 orders for 10 monitors: exactly 10 confirmed",
                        "Inventory down: 20 of 20 orders accepted, none lost",
                        "Kafka down: 20 of 20 accepted, all confirmed after",
                        "Accepted to confirmed: p50 232 ms"]):
    L.text(s_, 22, 456 + n * 22, 500, 20, fs=12)
L.text("CI builds both services, runs them on Kubernetes and repeats the outage drills on every push.", 22, 570, 500, 36, fs=12)
L.text("github.com/gumagatsby/event-driven-orders", 22, 646, 500, 18, fs=11, color=SUB)
open(f"{OUTDIR}/linkedin-architecture.drawio", "w").write(L.xml())
print("ok")
