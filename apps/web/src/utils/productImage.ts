type ImageObject = {
  url?: unknown;
  src?: unknown;
};

type ProductImageLike = {
  imageUrl?: unknown;
  image_url?: unknown;
  image?: unknown;
  images?: unknown;
  featuredImage?: unknown;
  featured_image?: unknown;
  thumbnail?: unknown;
};

function toImageString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice("http://".length)}`;
  return trimmed;
}

function fromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const objectValue = value as ImageObject;
  return toImageString(objectValue.url) || toImageString(objectValue.src);
}

function fromArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return toImageString(first) || fromObject(first);
}

export function resolveProductImageUrl(product: ProductImageLike): string | undefined {
  return (
    toImageString(product.imageUrl) ||
    toImageString(product.image_url) ||
    toImageString(product.image) ||
    fromObject(product.image) ||
    fromArray(product.images) ||
    fromObject(product.featuredImage) ||
    fromObject(product.featured_image) ||
    toImageString(product.thumbnail)
  );
}
