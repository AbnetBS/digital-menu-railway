"use client";

import { useState } from "react";
import { Star, CheckCircle2, ThumbsUp, Plus, UserCheck, MapPin, MessageSquareQuote } from "lucide-react";
import { Review } from "@/types";

interface ReviewsProps {
  reviews: Review[];
  onReviewSubmitted: () => void;
}

export default function ReviewsSection({ reviews, onReviewSubmitted }: ReviewsProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const highlights = [
    "Calm Atmosphere",
    "Cozy Cafe Vibe",
    "Refreshing Fruit Punches",
    "The Famous Fana Macchiato",
    "Friendly Staff",
    "Attractive Views & Seating",
  ];

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName || !reviewText) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName,
          rating,
          reviewText,
        }),
      });

      if (res.ok) {
        setCustomerName("");
        setReviewText("");
        setShowAddModal(false);
        onReviewSubmitted();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section id="reviews" className="py-20 bg-[#FAF6F0] relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#4E342E]/10 border border-[#4E342E]/20 text-[#4E342E] text-xs font-bold uppercase tracking-widest mb-3">
            <Star className="w-3.5 h-3.5 text-[#C9A227] fill-[#C9A227]" />
            <span>Google Maps Reviews</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-[#2C1B17]">
            What Visitors Say About Fana Cafe
          </h2>

          <p className="text-stone-600 text-sm sm:text-base mt-3">
            Real feedback and ratings from Google Maps Local Guides visiting Fana Cafe at Golagul Building, 22 Square, Addis Ababa.
          </p>
        </div>

        {/* Highlight Badges */}
        <div className="flex flex-wrap items-center justify-center gap-2 max-w-4xl mx-auto mb-12">
          {highlights.map((hl, idx) => (
            <div
              key={idx}
              className="flex items-center gap-1.5 bg-white border border-[#C9A227]/30 px-3.5 py-2 rounded-full text-xs font-bold text-[#2C1B17] shadow-sm"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>{hl}</span>
            </div>
          ))}
        </div>

        {/* Rating Summary Header with Google Rating Badge */}
        <div className="bg-[#4E342E] text-white rounded-3xl p-6 sm:p-8 border border-[#C9A227]/30 shadow-xl mb-12 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4 text-center md:text-left">
            <div className="text-4xl sm:text-5xl font-serif font-black text-[#C9A227]">3.7</div>
            <div>
              <div className="flex justify-center md:justify-start gap-1 text-[#C9A227]">
                {[...Array(4)].map((_, i) => (
                  <Star key={i} className="w-5 h-5 fill-[#C9A227]" />
                ))}
                <Star className="w-5 h-5 text-amber-500/40" />
              </div>
              <p className="text-xs text-amber-100/90 mt-1 font-bold flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-[#C9A227]" />
                Google Maps Rating (28 Reviews)
              </p>
            </div>
          </div>

          <div className="text-xs text-stone-300 max-w-md bg-black/30 p-4 rounded-2xl border border-amber-500/20">
            <p className="italic">
              "Guests frequently compliment our well-prepared coffee, refreshing fruit punches, and cozy atmosphere at Golagul Building. We continuously strive to improve order processing times during peak hours."
            </p>
          </div>

          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-2 bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-extrabold text-xs uppercase tracking-wider px-6 py-3.5 rounded-full shadow-lg hover:scale-105 transition shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>Write a Review</span>
          </button>
        </div>

        {/* Reviews Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {reviews.map((rev) => (
            <div
              key={rev.id}
              className="bg-white rounded-3xl p-6 border border-[#C9A227]/20 shadow-md flex flex-col justify-between space-y-4 hover:border-[#C9A227]/50 transition"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-[#4E342E] text-[#C9A227] font-bold text-sm flex items-center justify-center">
                      {rev.customerName.charAt(0)}
                    </div>
                    <div>
                      <h4 className="font-bold text-[#2C1B17] text-sm flex items-center gap-1">
                        <span>{rev.customerName}</span>
                        {rev.isVerified && (
                          <span title="Google Maps Local Guide">
                            <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                          </span>
                        )}
                      </h4>
                      <p className="text-[10px] text-stone-400">{rev.reviewDate}</p>
                    </div>
                  </div>

                  <div className="flex gap-1 text-[#C9A227]">
                    {[...Array(rev.rating)].map((_, i) => (
                      <Star key={i} className="w-3.5 h-3.5 fill-[#C9A227]" />
                    ))}
                  </div>
                </div>

                <p className="text-stone-700 text-xs sm:text-sm leading-relaxed font-light italic">
                  "{rev.reviewText}"
                </p>
              </div>

              <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-400">
                <span className="flex items-center gap-1 text-stone-500 font-semibold">
                  <MessageSquareQuote className="w-3.5 h-3.5 text-[#C9A227]" /> Google Local Guide
                </span>
                <span className="flex items-center gap-1 text-[#4E342E] font-semibold">
                  <ThumbsUp className="w-3 h-3 text-[#C9A227]" /> Verified
                </span>
              </div>
            </div>
          ))}
        </div>

      </div>

      {/* Review Submission Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="bg-[#2C1B17] rounded-3xl p-6 max-w-md w-full border border-[#C9A227] shadow-2xl text-white">
            
            <div className="flex justify-between items-center pb-4 border-b border-stone-800">
              <h3 className="font-serif font-bold text-lg text-amber-100">Leave Feedback for Fana Cafe</h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-stone-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitReview} className="space-y-4 mt-4">
              <div>
                <label className="block text-xs font-bold uppercase text-amber-200 mb-1">Your Name</label>
                <input
                  type="text"
                  required
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Samuel Yohannes"
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-100 focus:outline-none focus:border-[#C9A227]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-amber-200 mb-1">Rating</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setRating(star)}
                      className={`p-2 rounded-lg border text-sm font-bold flex items-center gap-1 ${
                        rating >= star
                          ? "bg-[#C9A227] text-[#2C1B17] border-[#C9A227]"
                          : "bg-[#3D2314] text-stone-400 border-stone-700"
                      }`}
                    >
                      ★ {star}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-amber-200 mb-1">Review Comments</label>
                <textarea
                  rows={3}
                  required
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                  placeholder="Tell us what you enjoyed about the famous macchiato, fruit punches, or open kitchen vibe..."
                  className="w-full bg-[#3D2314] border border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-100 focus:outline-none focus:border-[#C9A227]"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-[#C9A227] text-[#2C1B17] font-bold text-xs uppercase tracking-wider py-3 rounded-xl hover:bg-amber-400 transition"
              >
                {isSubmitting ? "Posting..." : "Submit Review"}
              </button>
            </form>

          </div>
        </div>
      )}

    </section>
  );
}
