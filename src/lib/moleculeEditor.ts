import { Molecule } from 'openchemlib'

export interface EditorAtom {
  element: string
  x: number
  y: number
  charge: number
}

export interface EditorBond {
  from: number
  to: number
  order: number
}

export interface EditorGraph {
  atoms: EditorAtom[]
  bonds: EditorBond[]
}

export const ELEMENT_NUMBERS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Molecule.cAtomLabel.slice(1, 119).map((label, index) => [label, index + 1])),
)

const BOND_LENGTH = 44
const WIDTH = 640
const HEIGHT = 360
const MARGIN = 60
const BOND_TYPES: Record<number, number> = {
  0: Molecule.cBondTypeMetalLigand,
  1: Molecule.cBondTypeSingle,
  2: Molecule.cBondTypeDouble,
  3: Molecule.cBondTypeTriple,
}

function copyGraph(graph: EditorGraph): EditorGraph {
  return { atoms: graph.atoms.map(atom => ({ ...atom })), bonds: graph.bonds.map(bond => ({ ...bond })) }
}

function isAtomIndex(graph: EditorGraph, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < graph.atoms.length
}

function graphToMolecule(graph: EditorGraph): Molecule {
  if (!Array.isArray(graph.atoms) || !Array.isArray(graph.bonds)) throw new Error('INVALID_GRAPH')
  if (!graph.atoms.length) throw new Error(graph.bonds.length ? 'INVALID_GRAPH' : 'EMPTY')
  const molecule = new Molecule(graph.atoms.length, graph.bonds.length)
  for (const atom of graph.atoms) {
    const atomicNo = ELEMENT_NUMBERS[atom.element]
    if (!atomicNo || !Number.isFinite(atom.x) || !Number.isFinite(atom.y) || !Number.isInteger(atom.charge)) throw new Error('INVALID_GRAPH')
    const index = molecule.addAtom(atomicNo)
    molecule.setAtomX(index, atom.x)
    molecule.setAtomY(index, atom.y)
    molecule.setAtomCharge(index, atom.charge)
  }

  const seen = new Set<string>()
  for (const bond of graph.bonds) {
    if (!isAtomIndex(graph, bond.from) || !isAtomIndex(graph, bond.to) || bond.from === bond.to || !Object.hasOwn(BOND_TYPES, bond.order)) throw new Error('INVALID_GRAPH')
    const pair = [Math.min(bond.from, bond.to), Math.max(bond.from, bond.to)].join(':')
    if (seen.has(pair)) throw new Error('INVALID_GRAPH')
    seen.add(pair)
    molecule.setBondType(molecule.addBond(bond.from, bond.to), BOND_TYPES[bond.order])
  }

  molecule.ensureHelperArrays(Molecule.cHelperNeighbours)
  for (let index = 0; index < molecule.getAllAtoms(); index += 1) {
    if (molecule.getOccupiedValence(index) > molecule.getMaxValence(index)) throw new Error('VALENCE')
  }
  molecule.stripStereoInformation()
  return molecule
}

function moleculeToGraph(molecule: Molecule): EditorGraph {
  molecule.stripStereoInformation()
  const atoms: EditorAtom[] = Array.from({ length: molecule.getAllAtoms() }, (_, index) => ({
    element: molecule.getAtomLabel(index),
    x: molecule.getAtomX(index),
    y: molecule.getAtomY(index),
    charge: molecule.getAtomCharge(index),
  }))
  const bonds: EditorBond[] = Array.from({ length: molecule.getAllBonds() }, (_, index) => ({
    from: molecule.getBondAtom(0, index),
    to: molecule.getBondAtom(1, index),
    order: molecule.getBondOrder(index),
  }))
  if (!atoms.length) return { atoms, bonds }

  const minX = Math.min(...atoms.map(atom => atom.x))
  const maxX = Math.max(...atoms.map(atom => atom.x))
  const minY = Math.min(...atoms.map(atom => atom.y))
  const maxY = Math.max(...atoms.map(atom => atom.y))
  const averageBond = molecule.getAverageBondLength(true) || Molecule.getDefaultAverageBondLength()
  const scale = Math.min(
    BOND_LENGTH / averageBond,
    maxX > minX ? (WIDTH - 2 * MARGIN) / (maxX - minX) : Infinity,
    maxY > minY ? (HEIGHT - 2 * MARGIN) / (maxY - minY) : Infinity,
  )
  return {
    atoms: atoms.map(atom => ({
      ...atom,
      x: WIDTH / 2 + (atom.x - (minX + maxX) / 2) * scale,
      y: HEIGHT / 2 + (atom.y - (minY + maxY) / 2) * scale,
    })),
    bonds,
  }
}

export function parseEditorSmiles(smiles: string): EditorGraph {
  if (!smiles.trim()) throw new Error('EMPTY')
  try {
    const molecule = Molecule.fromSmiles(smiles)
    if (!molecule.getAllAtoms()) throw new Error('EMPTY')
    molecule.stripStereoInformation()
    molecule.inventCoordinates({ keepHydrogens: true })
    return moleculeToGraph(molecule)
  } catch (error) {
    if (error instanceof Error && error.message === 'EMPTY') throw error
    throw new Error('INVALID_GRAPH')
  }
}

export function serializeEditorGraph(graph: EditorGraph): string {
  const molecule = graphToMolecule(graph)
  const smiles = molecule.toSmiles()
  const reconstructed = Molecule.fromSmiles(smiles)
  reconstructed.stripStereoInformation()
  if (reconstructed.getIDCode() !== molecule.getIDCode()) throw new Error('INVALID_GRAPH')
  return smiles
}

export function addEditorBond(graph: EditorGraph, from: number, to: number, order = 1): EditorGraph {
  if (!isAtomIndex(graph, from) || !isAtomIndex(graph, to) || from === to || !Object.hasOwn(BOND_TYPES, order)) throw new Error('INVALID_GRAPH')
  const result = copyGraph(graph)
  if (!graph.bonds.some(bond => (bond.from === from && bond.to === to) || (bond.from === to && bond.to === from))) {
    result.bonds.push({ from, to, order })
  }
  return result
}

export function removeEditorAtom(graph: EditorGraph, index: number): EditorGraph {
  if (!isAtomIndex(graph, index)) throw new Error('INVALID_GRAPH')
  return {
    atoms: graph.atoms.filter((_, atomIndex) => atomIndex !== index).map(atom => ({ ...atom })),
    bonds: graph.bonds.filter(bond => bond.from !== index && bond.to !== index).map(bond => ({
      ...bond,
      from: bond.from > index ? bond.from - 1 : bond.from,
      to: bond.to > index ? bond.to - 1 : bond.to,
    })),
  }
}

export function removeEditorBond(graph: EditorGraph, index: number): EditorGraph {
  if (!Number.isInteger(index) || index < 0 || index >= graph.bonds.length) throw new Error('INVALID_GRAPH')
  return { atoms: graph.atoms.map(atom => ({ ...atom })), bonds: graph.bonds.filter((_, bondIndex) => bondIndex !== index).map(bond => ({ ...bond })) }
}

export function addEditorRing(graph: EditorGraph, x: number, y: number, size: 3 | 6, aromatic: boolean): EditorGraph {
  if (!Number.isFinite(x) || !Number.isFinite(y) || (size !== 3 && size !== 6) || (aromatic && size !== 6)) throw new Error('INVALID_GRAPH')
  const result = copyGraph(graph)
  const offset = result.atoms.length
  const radius = BOND_LENGTH / (2 * Math.sin(Math.PI / size))
  for (let index = 0; index < size; index += 1) {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / size
    result.atoms.push({ element: 'C', x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle), charge: 0 })
    result.bonds.push({ from: offset + index, to: offset + (index + 1) % size, order: aromatic && index % 2 === 0 ? 2 : 1 })
  }
  return result
}

export function layoutEditorGraph(graph: EditorGraph): EditorGraph {
  if (!graph.atoms.length && !graph.bonds.length) return { atoms: [], bonds: [] }
  const molecule = graphToMolecule(graph)
  molecule.inventCoordinates({ keepHydrogens: true })
  return moleculeToGraph(molecule)
}
