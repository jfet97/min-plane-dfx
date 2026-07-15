import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = dirname(fileURLToPath(import.meta.url))

function pair(code, value) {
  return `${code}\n${value}\n`
}

function dxf(entities) {
  return [
    pair(0, 'SECTION'),
    pair(2, 'HEADER'),
    pair(9, '$ACADVER'),
    pair(1, 'AC1015'),
    pair(9, '$INSUNITS'),
    pair(70, 4),
    pair(0, 'ENDSEC'),
    pair(0, 'SECTION'),
    pair(2, 'ENTITIES'),
    ...entities,
    pair(0, 'ENDSEC'),
    pair(0, 'EOF')
  ].join('')
}

function layerName(layer) {
  return pair(8, layer)
}

function line(x1, y1, x2, y2, layer = 'CUT') {
  return [
    pair(0, 'LINE'),
    layerName(layer),
    pair(10, x1),
    pair(20, y1),
    pair(30, 0),
    pair(11, x2),
    pair(21, y2),
    pair(31, 0)
  ].join('')
}

function pointEntity(x, y, layer = 'REFERENCE') {
  return [pair(0, 'POINT'), layerName(layer), pair(10, x), pair(20, y), pair(30, 0)].join('')
}

function lwpolyline(points, { closed = true, layer = 'CUT', bulges = [] } = {}) {
  return [
    pair(0, 'LWPOLYLINE'),
    layerName(layer),
    pair(90, points.length),
    pair(70, closed ? 1 : 0),
    ...points.flatMap((point, index) => [
      pair(10, point[0]),
      pair(20, point[1]),
      bulges[index] === undefined ? '' : pair(42, bulges[index])
    ])
  ].join('')
}

function circle(cx, cy, radius, layer = 'CUT') {
  return [
    pair(0, 'CIRCLE'),
    layerName(layer),
    pair(10, cx),
    pair(20, cy),
    pair(30, 0),
    pair(40, radius)
  ].join('')
}

function arc(cx, cy, radius, startAngle, endAngle, layer = 'CUT') {
  return [
    pair(0, 'ARC'),
    layerName(layer),
    pair(10, cx),
    pair(20, cy),
    pair(30, 0),
    pair(40, radius),
    pair(50, startAngle),
    pair(51, endAngle)
  ].join('')
}

function ellipse(cx, cy, majorX, majorY, ratio, start = 0, end = Math.PI * 2, layer = 'CUT') {
  return [
    pair(0, 'ELLIPSE'),
    layerName(layer),
    pair(10, cx),
    pair(20, cy),
    pair(30, 0),
    pair(11, majorX),
    pair(21, majorY),
    pair(31, 0),
    pair(40, ratio),
    pair(41, start),
    pair(42, end)
  ].join('')
}

function rect(x, y, width, height, layer = 'CUT') {
  return lwpolyline(
    [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height]
    ],
    { layer }
  )
}

function regularPolygon(cx, cy, radius, sides, rotationDeg = 0, layer = 'CUT') {
  const rotation = (rotationDeg * Math.PI) / 180
  return lwpolyline(
    Array.from({ length: sides }, (_, index) => {
      const angle = rotation + (index * Math.PI * 2) / sides
      return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]
    }),
    { layer }
  )
}

function star(cx, cy, outerRadius, innerRadius, tips, rotationDeg = -90, layer = 'CUT') {
  const rotation = (rotationDeg * Math.PI) / 180
  return lwpolyline(
    Array.from({ length: tips * 2 }, (_, index) => {
      const radius = index % 2 === 0 ? outerRadius : innerRadius
      const angle = rotation + (index * Math.PI) / tips
      return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]
    }),
    { layer }
  )
}

function roundedRect(x, y, width, height, radius, layer = 'CUT') {
  return [
    line(x + radius, y, x + width - radius, y, layer),
    arc(x + width - radius, y + radius, radius, 270, 360, layer),
    line(x + width, y + radius, x + width, y + height - radius, layer),
    arc(x + width - radius, y + height - radius, radius, 0, 90, layer),
    line(x + width - radius, y + height, x + radius, y + height, layer),
    arc(x + radius, y + height - radius, radius, 90, 180, layer),
    line(x, y + height - radius, x, y + radius, layer),
    arc(x + radius, y + radius, radius, 180, 270, layer)
  ]
}

function trapezoid(x, y, topWidth, bottomWidth, height, layer = 'CUT') {
  const inset = (bottomWidth - topWidth) / 2
  return lwpolyline(
    [
      [x, y],
      [x + bottomWidth, y],
      [x + bottomWidth - inset, y + height],
      [x + inset, y + height]
    ],
    { layer }
  )
}

function triangle(x, y, width, height, skew = 0, layer = 'CUT') {
  return lwpolyline(
    [
      [x, y],
      [x + width, y],
      [x + width / 2 + skew, y + height]
    ],
    { layer }
  )
}

function diamond(cx, cy, width, height, layer = 'CUT') {
  return lwpolyline(
    [
      [cx, cy + height / 2],
      [cx + width / 2, cy],
      [cx, cy - height / 2],
      [cx - width / 2, cy]
    ],
    { layer }
  )
}

function writeFixture(fileName, entities) {
  writeFileSync(join(outDir, fileName), dxf(entities), 'utf8')
}

mkdirSync(outDir, { recursive: true })

writeFixture('triangle.dxf', [triangle(0, 0, 90, 70)])
writeFixture('trapezoid.dxf', [trapezoid(0, 0, 55, 115, 75)])
writeFixture('rounded-rectangle.dxf', [...roundedRect(0, 0, 125, 70, 18)])
writeFixture('angled-profile.dxf', [
  lwpolyline([
    [0, 0],
    [135, 0],
    [112, 28],
    [94, 86],
    [18, 72]
  ])
])
writeFixture('star-5-point.dxf', [star(55, 55, 55, 24, 5)])
writeFixture('circle-ellipse-arcs.dxf', [
  circle(35, 35, 30),
  ellipse(130, 35, 45, 0, 0.45),
  arc(235, 35, 35, 20, 320),
  arc(325, 35, 35, 200, 25)
])
writeFixture('convex-polygons.dxf', [
  triangle(0, 0, 80, 55),
  trapezoid(110, 0, 55, 95, 60),
  diamond(260, 30, 80, 60),
  regularPolygon(370, 30, 42, 6, 30),
  regularPolygon(480, 30, 42, 8, 22.5)
])
writeFixture('concave-and-stars.dxf', [
  star(45, 45, 45, 21, 5),
  star(160, 45, 45, 18, 6, -90),
  lwpolyline([
    [250, 0],
    [330, 0],
    [330, 30],
    [290, 30],
    [290, 70],
    [250, 70]
  ]),
  lwpolyline([
    [390, 0],
    [450, 0],
    [450, 25],
    [420, 25],
    [420, 50],
    [450, 50],
    [450, 75],
    [390, 75]
  ])
])
writeFixture('thin-and-awkward.dxf', [
  rect(0, 0, 160, 14),
  rect(0, 40, 140, 18),
  triangle(190, 0, 150, 35, 35),
  trapezoid(370, 0, 28, 135, 70),
  ...roundedRect(540, 0, 150, 26, 11)
])
writeFixture('mixed-sheet-like-screenshot.dxf', [
  ...roundedRect(20, 720, 120, 70, 20),
  diamond(80, 625, 82, 82),
  regularPolygon(250, 630, 85, 8, 18),
  trapezoid(35, 505, 95, 125, 75),
  triangle(45, 395, 120, 85, -25),
  ...roundedRect(35, 295, 130, 75, 18),
  rect(35, 205, 130, 72),
  triangle(35, 95, 150, 85, 40),
  star(285, 195, 75, 34, 5),
  arc(80, 25, 55, 0, 180),
  ...roundedRect(35, -95, 135, 75, 24),
  circle(80, -185, 45),
  rect(205, -220, 120, 85)
])
writeFixture('transform-cases.dxf', [
  regularPolygon(50, 50, 50, 3, 17),
  regularPolygon(170, 50, 50, 3, 197),
  trapezoid(270, 0, 45, 125, 95),
  diamond(480, 50, 145, 50),
  ...roundedRect(590, 10, 155, 65, 16)
])
writeFixture('near-collinear.dxf', [
  lwpolyline([
    [0, 0],
    [100, 0],
    [100.000001, 0.000001],
    [100, 42],
    [0, 42]
  ])
])
writeFixture('tiny-segments.dxf', [
  lwpolyline([
    [0, 0],
    [0.001, 0],
    [80, 0],
    [80, 0.001],
    [80, 35],
    [0, 35]
  ])
])
writeFixture('duplicate-points.dxf', [
  lwpolyline([
    [0, 0],
    [90, 0],
    [90, 0],
    [90, 45],
    [0, 45],
    [0, 0],
    [0, 0]
  ])
])
writeFixture('open-contour.dxf', [line(0, 0, 90, 0), line(90, 0, 90, 45), line(90, 45, 0, 45)])
writeFixture('unsupported-entities.dxf', [rect(0, 0, 90, 45), pointEntity(25, 20)])
writeFixture('high-padding.dxf', [triangle(0, 0, 70, 55)])
writeFixture('repeated-mixed-pieces.dxf', [
  rect(0, 0, 80, 40),
  triangle(110, 0, 60, 50),
  trapezoid(210, 0, 45, 80, 55),
  star(330, 30, 32, 14, 5)
])

console.log(`Generated DXF fixtures in ${outDir}`)
