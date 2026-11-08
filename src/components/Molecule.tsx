import { memo, useEffect, useRef } from 'react'
import SmilesDrawer from 'smiles-drawer'

export const Molecule = memo(function Molecule({ smiles, label, compact = false }: { smiles?: string; label: string; compact?: boolean }) {
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!smiles || !svg.current) return
    const element = svg.current
    const drawer = new SmilesDrawer.SvgDrawer({
      width: compact ? 200 : 300,
      height: compact ? 160 : 210,
      bondLength: 24,
      bondThickness: 1.25,
      padding: 20,
      fontSizeLarge: 13,
      fontSizeSmall: 8,
      themes: { light: { C: '#50405f', O: '#71547d', N: '#635082', F: '#4f7861', CL: '#4f7861', BR: '#86643f', I: '#684da0', P: '#876347', S: '#8f753f', B: '#876347', SI: '#876347', H: '#50405f', BACKGROUND: 'transparent' } },
    })
    SmilesDrawer.parse(smiles, tree => drawer.draw(tree, element, 'light'), () => {
      element.replaceChildren()
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', '10')
      text.setAttribute('y', '80')
      text.textContent = label
      element.appendChild(text)
    })
    return () => { element.replaceChildren() }
  }, [smiles, label, compact])

  if (!smiles) return <span className="molecule-formula chem">{label}</span>
  return <svg ref={svg} className="molecule" role="img" aria-label={`${label}的结构式`} />
})
