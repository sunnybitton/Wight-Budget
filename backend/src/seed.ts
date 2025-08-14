import { PrismaClient } from '../generated/prisma'

const prisma = new PrismaClient()

async function main() {
  const existing = await prisma.foodItem.count()
  if (existing > 0) return
  await prisma.foodItem.createMany({
    data: [
      { name: 'Apple', duby: 1.0 as any, unit: 'piece' },
      { name: 'Chicken Breast 100g', duby: 2.0 as any, unit: '100g' },
      { name: 'Rice 100g', duby: 3.0 as any, unit: '100g' },
    ],
  })
}

main().finally(async () => {
  await prisma.$disconnect()
})