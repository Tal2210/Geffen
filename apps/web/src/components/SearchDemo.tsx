import { useState, useEffect } from "react";

interface WineProduct {
  _id: string;
  name: string;
  description?: string;
  price: number;
  currency?: string;
  color?: string;
  country?: string;
  region?: string;
  grapes?: string[];
  vintage?: number;
  kosher?: boolean;
  imageUrl?: string;
  rating?: number;
  score: number;
  finalScore?: number;
}

interface SearchMetadata {
  query: string;
  appliedFilters: {
    colors?: string[];
    countries?: string[];
    priceRange?: { min?: number; max?: number };
    grapes?: string[];
    kosher?: boolean;
  };
  totalResults: number;
  returnedCount: number;
  timings: {
    parsing: number;
    embedding: number;
    vectorSearch: number;
    reranking: number;
    total: number;
  };
}

interface SearchResponse {
  products: WineProduct[];
  metadata: SearchMetadata;
}

interface SearchDemoProps {
  onBack?: () => void;
}

export function SearchDemo({ onBack }: SearchDemoProps) {
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [kosher, setKosher] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dynamically determine API_URL based on the current hostname
  const API_URL = `http://${window.location.hostname}:3000`;
  const API_KEY = "test_key_store_a";

  const handleSearch = async () => {
    console.log("handleSearch called", { query: query.trim(), maxPrice, selectedColors, kosher });
    if (!query.trim()) {
      console.log("Query is empty, returning.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({
          query: query.trim(),
          merchantId: "store_a",
          limit: 12,
          maxPrice: maxPrice ? parseInt(maxPrice) : undefined,
          colors: selectedColors.length > 0 ? selectedColors : undefined,
          kosher: kosher,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Error ${response.status}`);
      }

      const data: SearchResponse = await response.json();
      console.log("API Response Data:", data); // Log the response data
      setResults(data);
    } catch (err) {
      console.error("Search API Error:", err); // More detailed error log
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const toggleColor = (color: string) => {
    setSelectedColors((prev) =>
      prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]
    );
  };

  const colors = ["red", "white", "rosé", "sparkling"];

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-pink-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-lg border-b border-gray-200/50 sticky top-0 z-30 shadow-sm">
        <div className="px-6 lg:px-10 py-4 max-w-[1400px] mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center">
                <span className="text-white text-xl">🍷</span>
              </div>
              <div>
                <h1 className="text-lg font-bold text-gray-900">Wine Search Demo</h1>
                <p className="text-xs text-gray-500">Semantic search powered by AI</p>
              </div>
            </div>
            <button
              onClick={onBack}
              className="text-sm text-gray-600 hover:text-gray-900 font-medium"
            >
              ← Back to Insights
            </button>
          </div>
        </div>
      </header>

      <main className="px-6 lg:px-10 py-8 max-w-[1400px] mx-auto">
        {/* Search Section */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200/50 p-8 mb-8">
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              🔍 Search for wines
            </label>
            <div className="flex gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Try: 'fruity red wine from france' or 'יין לבן יבש'"
                className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none text-sm"
              />
              <button
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className={`px-8 py-3 rounded-xl font-semibold text-sm transition-all ${
                  loading || !query.trim()
                    ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:shadow-lg hover:scale-105 active:scale-95"
                }`}
              >
                {loading ? "Searching..." : "Search"}
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Colors */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-2">
                Wine Color
              </label>
              <div className="flex flex-wrap gap-2">
                {colors.map((color) => (
                  <button
                    key={color}
                    onClick={() => toggleColor(color)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      selectedColors.includes(color)
                        ? "bg-purple-600 text-white shadow-md"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    {color.charAt(0).toUpperCase() + color.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Price */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-2">
                Max Price ($)
              </label>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="e.g., 50"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none"
              />
            </div>

            {/* Kosher */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-2">
                Kosher
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setKosher(true)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    kosher === true
                      ? "bg-purple-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  Yes
                </button>
                <button
                  onClick={() => setKosher(undefined)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    kosher === undefined
                      ? "bg-purple-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  Any
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-8">
            <p className="text-red-800 text-sm">
              <strong>Error:</strong> {error}
            </p>
            <p className="text-red-600 text-xs mt-1">
              Make sure the Search API is running on localhost:3000
            </p>
          </div>
        )}

        {/* Results */}
        {results && (
          <>
            {/* Metadata */}
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl p-6 mb-8 border border-purple-200/50">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs text-gray-500 mb-1">Total Results</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {results.metadata.totalResults}
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs text-gray-500 mb-1">Parsing</p>
                  <p className="text-2xl font-bold text-green-600">
                    {results.metadata.timings.parsing}ms
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs text-gray-500 mb-1">Embedding</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {results.metadata.timings.embedding}ms
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs text-gray-500 mb-1">Vector Search</p>
                  <p className="text-2xl font-bold text-orange-600">
                    {results.metadata.timings.vectorSearch}ms
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs text-gray-500 mb-1">Total Time</p>
                  <p className="text-2xl font-bold text-pink-600">
                    {results.metadata.timings.total}ms
                  </p>
                </div>
              </div>

              {/* Applied Filters */}
              {Object.keys(results.metadata.appliedFilters).length > 0 && (
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-xs font-semibold text-gray-600 mb-2">
                    Applied Filters:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {results.metadata.appliedFilters.colors?.map((c) => (
                      <span
                        key={c}
                        className="px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs font-medium"
                      >
                        Color: {c}
                      </span>
                    ))}
                    {results.metadata.appliedFilters.countries?.map((c) => (
                      <span
                        key={c}
                        className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-medium"
                      >
                        Country: {c}
                      </span>
                    ))}
                    {results.metadata.appliedFilters.priceRange && (
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
                        Price: ${results.metadata.appliedFilters.priceRange.min || 0} -{" "}
                        ${results.metadata.appliedFilters.priceRange.max || "∞"}
                      </span>
                    )}
                    {results.metadata.appliedFilters.kosher && (
                      <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium">
                        Kosher
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Products Grid */}
            {results.products.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-gray-500 text-lg">No wines found</p>
                <p className="text-gray-400 text-sm mt-2">
                  Try a different search or adjust your filters
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {results.products.map((product) => (
                  <div
                    key={product._id}
                    className="bg-white rounded-xl shadow-md hover:shadow-xl transition-all border border-gray-200/50 overflow-hidden group hover:scale-105"
                  >
                    {/* Image Placeholder */}
                    <div className="h-40 bg-gradient-to-br from-purple-100 to-pink-100 flex items-center justify-center">
                      <span className="text-6xl">🍷</span>
                    </div>

                    {/* Content */}
                    <div className="p-4">
                      <h3 className="font-bold text-gray-900 mb-1 line-clamp-2 group-hover:text-purple-600 transition-colors">
                        {product.name}
                      </h3>

                      {product.description && (
                        <p className="text-xs text-gray-500 mb-3 line-clamp-2">
                          {product.description}
                        </p>
                      )}

                      {/* Details */}
                      <div className="space-y-1.5 mb-3">
                        {product.color && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="w-3 h-3 rounded-full bg-gradient-to-r from-red-400 to-purple-400"></span>
                            <span className="text-gray-600 capitalize">{product.color}</span>
                          </div>
                        )}
                        {product.country && (
                          <div className="flex items-center gap-2 text-xs">
                            <span>🌍</span>
                            <span className="text-gray-600 capitalize">{product.country}</span>
                          </div>
                        )}
                        {product.grapes && product.grapes.length > 0 && (
                          <div className="flex items-center gap-2 text-xs">
                            <span>🍇</span>
                            <span className="text-gray-600 capitalize">
                              {product.grapes.slice(0, 2).join(", ")}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Price & Score */}
                      <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                        <div>
                          <p className="text-2xl font-bold text-purple-600">
                            ${product.price}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-gray-400">Match Score</p>
                          <p className="text-sm font-bold text-pink-600">
                            {Math.round((product.finalScore || product.score) * 100)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Initial State */}
        {!results && !error && !loading && (
          <div className="text-center py-20">
            <div className="text-8xl mb-6">🍷</div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">
              Search for Wines
            </h2>
            <p className="text-gray-500">
              Try searching for "red wine from france" or "יין לבן יבש"
            </p>
            <div className="mt-8 flex justify-center gap-3">
              <button
                onClick={() => {
                  setQuery("red wine from bordeaux");
                  setTimeout(handleSearch, 100);
                }}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700"
              >
                Try: Bordeaux Red
              </button>
              <button
                onClick={() => {
                  setQuery("יין לבן יבש");
                  setTimeout(handleSearch, 100);
                }}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700"
              >
                Try: יין לבן יבש
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
