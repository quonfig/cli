import {z} from 'zod'

export class JsonToZodMapper {
  resolve(data: unknown): z.ZodTypeAny {
    if (Array.isArray(data)) {
      if (data.length > 0) {
        // Check if all elements in the array have the same type
        const firstItem = data[0]

        const isHomogeneous = data.every((item) => {
          const itemsMatch = typeof item === typeof firstItem

          // Special handling for objects and arrays
          if (typeof firstItem === 'object') {
            if (Array.isArray(item)) {
              return Array.isArray(firstItem)
            }

            return !Array.isArray(firstItem)
          }

          return itemsMatch
        })

        // For homogeneous arrays, use the first element's type
        if (isHomogeneous) {
          return z.array(this.resolve(data[0]))
        }

        // Explicitly do not handle mixed-type arrays
        // They could be tuples or heterogeneous arrays
        // Instead, we return an array of unknowns
      }

      return z.array(z.unknown())
    }

    if (typeof data === 'object' && data !== null) {
      const shape: Record<string, z.ZodTypeAny> = {}
      const dataRecord = data as Record<string, unknown>
      for (const key in dataRecord) {
        if (Object.hasOwn(dataRecord, key)) {
          shape[key] = this.resolve(dataRecord[key])
        }
      }

      return z.object(shape)
    }

    if (typeof data === 'string') {
      return z.string()
    }

    if (typeof data === 'number') {
      return z.number()
    }

    if (typeof data === 'boolean') {
      return z.boolean()
    }

    if (data === null) {
      return z.null()
    }

    console.warn(`Unknown json type:`, data)

    // If the type is not recognized, default to 'any'
    return z.any()
  }
}
