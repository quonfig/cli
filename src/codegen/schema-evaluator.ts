// TODO: We should resolve these any references to ensure generation is fully type-safe
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import {z} from 'zod'

import {ZodTypeSupported} from './types.js'

/**
 * Options for the secure schema validator
 */
export interface SecureSchemaValidatorOptions {
  /**
   * Whether to perform AST validation
   */
  astValidation?: boolean

  /**
   * Maximum allowed AST nodes to prevent DoS attacks
   */
  maxAstNodes?: number
}

/**
 * Default options for the secure schema validator
 */
const DEFAULT_OPTIONS: SecureSchemaValidatorOptions = {
  astValidation: true,
  maxAstNodes: 500,
}

/**
 * Validates a JavaScript expression AST for potentially unsafe operations
 *
 * @param ast - The AST to validate
 * @param parentMap - Map of nodes to their parent nodes
 * @returns An object with validation result and optional error message
 */
export function validateAst(ast: any, parentMap: WeakMap<any, any>): {error?: string; isValid: boolean} {
  let isValid = true
  let error: string | undefined

  // Track what we've seen for detailed error messages
  const issues: string[] = []

  // Count nodes to prevent DoS attacks with extremely large schemas
  let nodeCount = 0

  // Helper function to check if an arrow function is used in a valid Zod method context
  const isValidZodMethodArg = (node: any): boolean => {
    // Check if this node is an argument to a method call
    const parent = parentMap.get(node)
    if (parent && parent.type === 'CallExpression' && parent.callee && parent.callee.type === 'MemberExpression') {
      // Check if method is on an object that's part of a valid Zod chain
      const memberExpr = parent.callee

      // Allow methods like refine, transform, superRefine, etc.
      const allowedMethods = ['refine', 'transform', 'superRefine', 'pipe', 'preprocess']
      if (memberExpr.property && memberExpr.property.name && allowedMethods.includes(memberExpr.property.name)) {
        return true
      }
    }

    return false
  }

  // Count all nodes separately to track complexity
  walk.full(ast, () => {
    nodeCount++
  })

  // Custom AST walker to check for unsafe patterns
  walk.simple(ast, {
    ArrowFunctionExpression(node) {
      // Allow arrow functions only in valid Zod method contexts
      if (!isValidZodMethodArg(node)) {
        issues.push(`Forbidden standalone arrow function`)
        isValid = false
      }
    },

    // Block async/await
    AwaitExpression() {
      issues.push('Await expressions are not allowed')
      isValid = false
    },

    // Restrict function calls
    CallExpression(node: any) {
      if (node.callee.type === 'MemberExpression') {
        const obj = node.callee.object
        if (obj.type === 'Identifier' && obj.name !== 'z') {
          issues.push(`Only calls to z.* methods are allowed, found: ${obj.name}`)
          isValid = false
        }
      } else if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        issues.push(`Forbidden function call: require`)
        isValid = false
      } else if (node.callee.type === 'Identifier' && !['z'].includes(node.callee.name)) {
        issues.push(`Forbidden function call: ${node.callee.name}`)
        isValid = false
      }
    },

    // Block class declarations
    ClassDeclaration() {
      issues.push(`Forbidden node type: ClassDeclaration`)
      isValid = false
    },

    ClassExpression() {
      issues.push(`Forbidden node type: ClassExpression`)
      isValid = false
    },

    ExportAllDeclaration() {
      issues.push(`Forbidden operation: ExportAllDeclaration`)
      isValid = false
    },

    ExportDefaultDeclaration() {
      issues.push(`Forbidden operation: ExportDefaultDeclaration`)
      isValid = false
    },

    ExportNamedDeclaration() {
      issues.push(`Forbidden operation: ExportNamedDeclaration`)
      isValid = false
    },

    // Block function declarations
    FunctionDeclaration() {
      issues.push(`Forbidden node type: FunctionDeclaration`)
      isValid = false
    },

    FunctionExpression() {
      issues.push(`Forbidden node type: FunctionExpression`)
      isValid = false
    },

    // Block access to global objects and require
    Identifier(node) {
      const parent = parentMap.get(node)
      const forbiddenGlobals = [
        'window',
        'global',
        'process',
        'console',
        'document',
        'navigator',
        'localStorage',
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        'eval',
        'require',
      ]

      if (forbiddenGlobals.includes(node.name) && !(parent?.type === 'MemberExpression' && parent.property === node)) {
        issues.push(`Forbidden global object: ${node.name}`)
        isValid = false
      }
    },

    // Block imports, exports
    ImportDeclaration() {
      issues.push(`Forbidden operation: ImportDeclaration`)
      isValid = false
    },

    // Block dangerous property access
    MemberExpression(node) {
      if (node.property.type === 'Identifier') {
        const dangerousProps = [
          'constructor',
          'prototype',
          '__proto__',
          '__defineGetter__',
          '__defineSetter__',
          '__lookupGetter__',
          '__lookupSetter__',
        ]

        if (dangerousProps.includes(node.property.name)) {
          issues.push(`Forbidden property access: ${node.property.name}`)
          isValid = false
        }
      }
    },
  })

  if (nodeCount > DEFAULT_OPTIONS.maxAstNodes!) {
    isValid = false
    issues.push(`Schema exceeds maximum allowed complexity (${nodeCount} nodes > ${DEFAULT_OPTIONS.maxAstNodes} limit)`)
  }

  if (!isValid) {
    error = `Schema contains potentially unsafe operations: ${issues.join(', ')}`
  }

  return {error, isValid}
}

/**
 * Removes .describe() calls from the AST by filtering them out
 * This is more robust than regex as it properly handles nested structures
 *
 * @param ast - The AST to process
 * @param schemaString - The original schema string
 * @returns The schema string with .describe() calls removed
 */
function removeDescribeCalls(ast: any, schemaString: string): string {
  const nodesToRemove: Array<{start: number; end: number}> = []

  // Walk the AST and find all .describe() calls
  walk.simple(ast, {
    CallExpression(node: any) {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'describe'
      ) {
        // Mark the entire .describe(...) call for removal
        // We want to remove from the dot before 'describe' to the closing paren
        const start = node.callee.property.start - 1 // Include the dot
        const end = node.end
        nodesToRemove.push({start, end})
      }
    },
  })

  // Sort in reverse order so we can remove from the end without affecting earlier positions
  nodesToRemove.sort((a, b) => b.start - a.start)

  let result = schemaString
  for (const {start, end} of nodesToRemove) {
    result = result.slice(0, Math.max(0, start)) + result.slice(Math.max(0, end))
  }

  return result
}

/**
 * Securely evaluates a Zod schema string using AST validation
 *
 * @param schemaString - The schema string to evaluate
 * @param options - Options for secure evaluation
 * @returns The evaluated schema or an error
 */
export function secureEvaluateSchema(
  schemaString: string,
  options: SecureSchemaValidatorOptions = {},
): {error?: string; schema?: ZodTypeSupported; success: boolean} {
  const mergedOptions = {...DEFAULT_OPTIONS, ...options}
  const trimmedSchema = schemaString.trim()

  try {
    // Phase 1: AST Validation (Static Analysis)
    if (mergedOptions.astValidation) {
      // Parse the schema string into an AST
      const ast = acorn.parse(trimmedSchema, {
        allowAwaitOutsideFunction: false,
        ecmaVersion: 2020,
        sourceType: 'script',
      })

      // Create a map to track parent-child relationships
      const parentMap = new WeakMap<any, any>()

      // Function to build parent-child relationships
      function buildParentChildRelationships(node: any, parent: any = null) {
        if (parent) {
          parentMap.set(node, parent)
        }

        // Recursively process all properties that might contain child nodes
        for (const key in node) {
          if (Object.hasOwn(node, key)) {
            const child = node[key]

            if (child && typeof child === 'object') {
              if (Array.isArray(child)) {
                for (const item of child) {
                  if (item && typeof item === 'object') {
                    buildParentChildRelationships(item, node)
                  }
                }
              } else {
                buildParentChildRelationships(child, node)
              }
            }
          }
        }
      }

      // Build the parent-child relationships
      buildParentChildRelationships(ast)

      // Validate the AST for security concerns
      const {error, isValid} = validateAst(ast, parentMap)

      if (!isValid) {
        return {error, success: false}
      }

      // Remove .describe() calls after validation
      const filteredSchema = removeDescribeCalls(ast, trimmedSchema)

      // Phase 2: Execute with Function constructor
      // We're deliberately avoiding VM modules due to security concerns
      // The AST validation provides our primary security layer
      // eslint-disable-next-line no-new-func
      const constructSchema = new Function('z', `return ${filteredSchema}`)
      const schema = constructSchema(z)

      // Phase 3: Validate Result
      if (!schema || typeof schema !== 'object' || !('_def' in schema)) {
        return {
          error: 'The provided string did not evaluate to a valid Zod schema',
          success: false,
        }
      }

      return {schema, success: true}
    }

    // If AST validation is disabled, just execute directly (not recommended)
    // eslint-disable-next-line no-new-func
    const constructSchema = new Function('z', `return ${trimmedSchema}`)
    const schema = constructSchema(z)

    // Phase 3: Validate Result
    if (!schema || typeof schema !== 'object' || !('_def' in schema)) {
      return {
        error: 'The provided string did not evaluate to a valid Zod schema',
        success: false,
      }
    }

    return {schema, success: true}
  } catch (error) {
    return {
      error: error instanceof Error ? `Evaluation error: ${error.message}` : 'Unknown evaluation error',
      success: false,
    }
  }
}
