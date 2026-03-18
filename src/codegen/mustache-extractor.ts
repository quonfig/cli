import {z} from 'zod'

interface MustacheNode {
  children: MustacheNode[]
  isInverted: boolean
  isSection: boolean
  name: string
}

// Extracts a zod schema from a mustache template.
// eg "Hello {{name}}!" -> z.object({ name: z.string() })
export class MustacheExtractor {
  static extractSchema(
    template: string,
    log: (category: string | unknown, message?: unknown) => void,
  ): z.ZodObject<Record<string, z.ZodTypeAny>> {
    if (!template) {
      return z.object({})
    }

    const nodes = this.parseMustacheTemplate(template, log)
    return this.generateZodSchema(nodes)
  }

  private static generateZodSchema(nodes: MustacheNode[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const properties: Record<string, z.ZodTypeAny> = {}

    for (const node of nodes) {
      if (node.isSection) {
        if (node.children.length > 0) {
          const childSchema = this.generateZodSchema(node.children)
          properties[node.name] = node.isInverted ? childSchema.optional() : z.array(childSchema)
        } else {
          properties[node.name] = node.isInverted ? z.boolean().optional() : z.boolean()
        }
      } else if (!properties[node.name]) {
        properties[node.name] = z.string()
      }
    }

    return z.object(properties)
  }

  private static parseMustacheTemplate(
    template: string,
    log: (category: string | unknown, message?: unknown) => void,
  ): MustacheNode[] {
    const tokens = template.match(/{{[^}]+}}|[^{}]+/g) || []
    const root: MustacheNode[] = []
    const stack: MustacheNode[][] = [root]

    for (const token of tokens) {
      if (!token.startsWith('{{')) continue

      const content = token.slice(2, -2).trim()

      // Add check for partials
      if (content.startsWith('>')) {
        log(`Found Mustache partial: ${content.slice(1)}`)
        continue
      }

      if (content.startsWith('#')) {
        // Section start
        const name = content.slice(1)
        const newSection: MustacheNode = {
          children: [],
          isInverted: false,
          isSection: true,
          name,
        }
        stack.at(-1)!.push(newSection)
        stack.push(newSection.children)
      } else if (content.startsWith('^')) {
        // Inverted section
        const name = content.slice(1)
        const newSection: MustacheNode = {
          children: [],
          isInverted: true,
          isSection: true,
          name,
        }
        stack.at(-1)!.push(newSection)
        stack.push(newSection.children)
      } else if (content.startsWith('/')) {
        // Section end
        stack.pop()
      } else {
        // Regular variable
        stack.at(-1)!.push({
          children: [],
          isInverted: false,
          isSection: false,
          name: content,
        })
      }
    }

    return root
  }
}
