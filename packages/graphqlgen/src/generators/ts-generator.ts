import * as os from 'os'
import * as capitalize from 'capitalize'
import * as prettier from 'prettier'
import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'

import { GenerateArgs, ModelMap } from './types'
import { GraphQLTypeField, GraphQLTypeObject } from '../source-helper'

type SpecificGraphQLScalarType = 'boolean' | 'number' | 'string'

interface InputTypesMap {
  [s: string]: GraphQLTypeObject
}

interface TypeToInputTypeAssociation {
  [s: string]: any
}

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'typescript',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  return `\
  ${renderHeader(args)}

  ${renderNamespaces(args, typeToInputTypeAssociation, inputTypesMap)}

  ${renderIResolvers(args)}

  `
}

function renderHeader(args: GenerateArgs): string {
  const modelArray = Object.keys(args.modelMap).map(k => args.modelMap[k])
  const modelImports = modelArray
    .map(
      m =>
        `import { ${m.modelTypeName} } from '${m.importPathRelativeToOutput}'`,
    )
    .join(os.EOL)

  return `
/* DO NOT EDIT! */
import { GraphQLResolveInfo } from 'graphql'
import { Context } from '${args.contextPath}'
${modelImports}
  `
}

function renderNamespaces(
  args: GenerateArgs,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return args.types
    .filter(type => type.type.isObject)
    .map(type =>
      renderNamespace(
        type,
        typeToInputTypeAssociation,
        inputTypesMap,
        args.modelMap,
      ),
    )
    .join(os.EOL)
}

function renderNamespace(
  type: GraphQLTypeObject,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  modelMap: ModelMap,
): string {
  return `\
    export namespace ${type.name}Resolvers {

    ${renderScalarResolvers(type, modelMap)}

    ${
      typeToInputTypeAssociation[type.name]
        ? `export interface ${
            inputTypesMap[typeToInputTypeAssociation[type.name]].name
          } {
      ${inputTypesMap[typeToInputTypeAssociation[type.name]].fields.map(
        field => `${field.name}: ${getTypeFromGraphQLType(field.type.name)}`,
      )}
    }`
        : ``
    }  

    ${renderInputArgInterfaces(type, modelMap)}

    ${renderResolverFunctionInterfaces(type, modelMap)}

    ${renderResolverTypeInterfaces(type, modelMap)}
  }
  `
}

function renderScalarResolvers(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  const model = modelMap[type.name]

  if (model === undefined) {
    return `export const defaultResolvers = {}`
  }

  const filePath = model.absoluteFilePath
  const fileName = path.basename(filePath)

  const sourceFile = ts.createSourceFile(
    fileName,
    fs.readFileSync(filePath).toString(),
    ts.ScriptTarget.ES2015,
  )

  // NOTE unfortunately using `.getChildren()` didn't work, so we had to use the `forEachChild` method
  const nodes: ts.Node[] = []
  sourceFile.forEachChild(node => {
    nodes.push(node)
  })

  const node = nodes.find(
    node =>
      node.kind === ts.SyntaxKind.InterfaceDeclaration &&
      (node as ts.InterfaceDeclaration).name.escapedText ===
        model.modelTypeName,
  )

  if (!node) {
    throw new Error(`No interface found for name ${model.modelTypeName}`)
  }

  // NOTE unfortunately using `.getChildren()` didn't work, so we had to use the `forEachChild` method
  const childNodes: ts.Node[] = []
  node.forEachChild(childNode => {
    childNodes.push(childNode)
  })

  return `export const defaultResolvers = {
    ${childNodes
      .filter(childNode => childNode.kind === ts.SyntaxKind.PropertySignature)
      .map(childNode => renderScalarResolver(childNode))
      .join(os.EOL)}
  }`
}

function renderScalarResolver(childNode: ts.Node): string {
  const childNodeProperty = childNode as ts.PropertySignature
  const fieldName = (childNodeProperty.name as ts.Identifier).text
  // const typeName = (childNodeProperty.type! as ts.TypeReferenceNode).typeName
  return `${fieldName}: parent => parent.${fieldName},`
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return type.fields
    .map(field => renderInputArgInterface(field, modelMap))
    .join(os.EOL)
}

function renderInputArgInterface(
  field: GraphQLTypeField,
  modelMap: ModelMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface Args${capitalize(field.name)} {
    ${field.arguments
      .map(
        arg =>
          `${arg.name}: ${printFieldLikeType(
            arg as GraphQLTypeField,
            modelMap,
          )}`,
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return type.fields
    .map(field => renderResolverFunctionInterface(field, type, modelMap))
    .join(os.EOL)
}

function renderResolverFunctionInterface(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  // TODO double check parent for union/enum
  //   parent: ${getModelName(type.name, modelMap)}${
  //   type.type.isEnum || type.type.isUnion ? '' : 'Parent'
  // },
  return `
  export type ${capitalize(field.name)}Resolver = (
    parent: ${getModelName(type.name, modelMap)},
    args: ${
      field.arguments.length > 0 ? `Args${capitalize(field.name)}` : '{}'
    },
    ctx: Context,
    info: GraphQLResolveInfo,
  ) => ${printFieldLikeType(field, modelMap)} | Promise<${printFieldLikeType(
    field,
    modelMap,
  )}>
  `
}

function renderResolverTypeInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return `
  export interface Type {
    ${type.fields
      .map(field => renderResolverTypeInterface(field, type, modelMap))
      .join(os.EOL)}
  }
  `
}

function renderResolverTypeInterface(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return `
    ${field.name}: (
      parent: ${getModelName(type.name, modelMap)},
      args: ${
        field.arguments.length > 0 ? `Args${capitalize(field.name)}` : '{}'
      },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => ${printFieldLikeType(field, modelMap)} | Promise<${printFieldLikeType(
    field,
    modelMap,
  )}>
  `
}

function renderIResolvers(args: GenerateArgs): string {
  return `
export interface IResolvers {
  ${args.types
    .filter(type => type.type.isObject)
    .map(type => `${type.name}: ${type.name}Resolvers.Type`)
    .join(os.EOL)}
}
  `
}

function getModelName(typeName: string, modelMap: ModelMap): string {
  const model = modelMap[typeName]

  // NOTE if no model is found, return the empty type
  // It's usually assumed that every GraphQL type has a model associated
  // expect for the `Query`, `Mutation` and `Subscription` type
  if (model === undefined) {
    return '{}'
  }

  return model.modelTypeName
}

function printFieldLikeType(field: GraphQLTypeField, modelMap: ModelMap) {
  if (field.type.isScalar) {
    return `${getTypeFromGraphQLType(field.type.name)}${
      field.type.isArray ? '[]' : ''
    }${!field.type.isRequired ? '| null' : ''}`
  }

  if (field.type.isInput) {
    return `${field.type.name}${field.type.isArray ? '[]' : ''}${
      !field.type.isRequired ? '| null' : ''
    }`
  }

  return `${getModelName(field.type.name, modelMap)}${
    field.type.isArray ? '[]' : ''
  }${!field.type.isRequired ? '| null' : ''}`
}

function getTypeFromGraphQLType(type: string): SpecificGraphQLScalarType {
  if (type === 'Int' || type === 'Float') {
    return 'number'
  }
  if (type === 'Boolean') {
    return 'boolean'
  }
  if (type === 'String' || type === 'ID' || type === 'DateTime') {
    return 'string'
  }
  return 'string'
}
