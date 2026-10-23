from pathlib import Path

import ezdxf

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def build(name: str, units: int) -> None:
    doc = ezdxf.new("R2013", setup=False)
    doc.header["$INSUNITS"] = units
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    doc.header["$LUPREC"] = 3
    doc.layers.add("SIGNAL", color=3)
    doc.layers.add("ROAD-CENTERLINE", color=7)

    msp = doc.modelspace()
    msp.add_point((500000, 3450000), dxfattribs={"layer": "SIGNAL"})
    msp.add_text("S1", height=2.5, dxfattribs={"layer": "SIGNAL"}).set_placement((500002, 3450002))
    msp.add_line((500000, 3449990), (500050, 3449990), dxfattribs={"layer": "ROAD-CENTERLINE"})
    doc.saveas(FIXTURES / name)


if __name__ == "__main__":
    FIXTURES.mkdir(parents=True, exist_ok=True)
    build("09_existing_r2013.dxf", 6)
    build("10_units_missing.dxf", 0)
    print("created", FIXTURES / "09_existing_r2013.dxf", FIXTURES / "10_units_missing.dxf")
