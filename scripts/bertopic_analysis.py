#!/usr/bin/env python3
"""
BERTopic analysis script for Bartelby.

Reads a JSON file with document texts and existing embeddings,
generates embeddings for new documents, runs BERTopic, and writes
topic data back to a JSON output file.

Usage:
  python scripts/bertopic_analysis.py --input /tmp/bertopic_in.json --output /tmp/bertopic_out.json
"""

import sys
import json
import argparse
import warnings
warnings.filterwarnings('ignore')

import numpy as np
from sentence_transformers import SentenceTransformer
from bertopic import BERTopic
from bertopic._utils import get_unique_distances, select_topic_representation, validate_distance_matrix
from umap import UMAP
from hdbscan import HDBSCAN
from scipy.cluster import hierarchy as sch
from sklearn.metrics.pairwise import cosine_similarity


def load_input(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_output(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)


def generate_embeddings(texts, model_name='all-MiniLM-L6-v2'):
    """Generate sentence embeddings for a list of texts."""
    model = SentenceTransformer(model_name)
    embeddings = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
    return embeddings.tolist()


def run_bertopic(all_doc_ids, all_embeddings_list, all_texts, dates=None):
    """
    Run BERTopic on the full set of documents.
    Returns topics, probabilities, UMAP 2D coords, hierarchy, and evolution data.
    """
    embeddings = np.array(all_embeddings_list)
    n_docs = len(all_texts)

    if n_docs < 5:
        return None

    umap_model = UMAP(
        n_neighbors=min(15, n_docs - 1),
        n_components=2,
        min_dist=0.0,
        metric='cosine',
        random_state=42
    )
    hdbscan_model = HDBSCAN(
        min_cluster_size=max(2, n_docs // 10),
        min_samples=1,
        metric='euclidean',
        cluster_selection_method='eom',
        prediction_data=True
    )

    topic_model = BERTopic(
        umap_model=umap_model,
        hdbscan_model=hdbscan_model,
        calculate_probabilities=True,
        verbose=False
    )

    topics, probs = topic_model.fit_transform(all_texts, embeddings=embeddings)

    umap_2d = umap_model.embedding_  # shape: (n_docs, 2)

    topic_info = topic_model.get_topic_info()
    topics_out = []
    for _, row in topic_info.iterrows():
        tid = int(row['Topic'])
        if tid == -1:
            label = 'Outlier'
        else:
            words = topic_model.get_topic(tid)
            label = '_'.join([w for w, _ in words[:3]]) if words else f'Topic {tid}'
        words_data = []
        if tid != -1:
            raw_words = topic_model.get_topic(tid) or []
            words_data = [{'word': w, 'weight': float(s)} for w, s in raw_words[:10]]
        topics_out.append({
            'topic_id': tid,
            'topic_label': label,
            'topic_words': words_data,
            'document_count': int(row['Count']),
            'parent_topic_id': None
        })

    assignments_out = []
    for i, doc_id in enumerate(all_doc_ids):
        prob_val = probs[i]
        if hasattr(prob_val, '__iter__'):
            prob = float(max(prob_val))
        else:
            prob = float(prob_val)
        assignments_out.append({
            'document_id': doc_id,
            'topic_id': int(topics[i]),
            'probability': round(prob, 4),
            'x_coord': round(float(umap_2d[i][0]), 4),
            'y_coord': round(float(umap_2d[i][1]), 4)
        })

    try:
        hier_topics = topic_model.hierarchical_topics(all_texts)
        hierarchy_out = []
        for _, row in hier_topics.iterrows():
            hierarchy_out.append({
                'parent_id': int(row['Parent_ID']),
                'parent_name': str(row['Parent_Name']),
                'topics': [int(t) for t in row['Topics']],
                'child_left_id': int(row['Child_Left_ID']),
                'child_left_name': str(row['Child_Left_Name']),
                'child_right_id': int(row['Child_Right_ID']),
                'child_right_name': str(row['Child_Right_Name']),
                'distance': float(row['Distance'])
            })
        hierarchy_plot = build_hierarchy_plot(topic_model, [topic['topic_id'] for topic in topics_out if topic['topic_id'] != -1])
    except Exception as e:
        print(f'[bertopic] hierarchy error: {e}', file=sys.stderr)
        hierarchy_out = []
        hierarchy_plot = None

    evolution_out = []
    if dates and len(dates) == len(all_texts):
        try:
            timestamps = [d if d else '1800-01-01' for d in dates]
            topics_over_time = topic_model.topics_over_time(
                all_texts, timestamps, nr_bins=10
            )
            for _, row in topics_over_time.iterrows():
                evolution_out.append({
                    'topic_id': int(row['Topic']),
                    'time_period': str(row['Timestamp'])[:7],
                    'document_count': int(row['Frequency'])
                })
        except Exception as e:
            print(f'[bertopic] evolution error: {e}', file=sys.stderr)

    return {
        'topics': topics_out,
        'assignments': assignments_out,
        'hierarchy': hierarchy_out,
        'hierarchy_plot': hierarchy_plot,
        'evolution': evolution_out
    }


def build_hierarchy_plot(topic_model, topic_ids):
    if len(topic_ids) < 2:
        return None

    topic_ids = sorted(topic_ids)
    all_topics = sorted(list(topic_model.get_topics().keys()))
    indices = np.array([all_topics.index(topic_id) for topic_id in topic_ids])
    embeddings = select_topic_representation(
        topic_model.c_tf_idf_,
        topic_model.topic_embeddings_,
        use_ctfidf=True
    )[0][indices]

    X = 1 - cosine_similarity(embeddings)
    X = validate_distance_matrix(X, embeddings.shape[0])
    Z = sch.linkage(X, 'ward', optimal_ordering=True)

    if len(Z[:, 2]) != len(np.unique(Z[:, 2])):
        Z[:, 2] = get_unique_distances(Z[:, 2])

    dendrogram = sch.dendrogram(Z, orientation='left', no_plot=True)
    return {
        'orientation': 'left',
        'leaf_topic_ids': [int(topic_ids[index]) for index in dendrogram['leaves']],
        'icoord': [[float(value) for value in row] for row in dendrogram['icoord']],
        'dcoord': [[float(value) for value in row] for row in dendrogram['dcoord']],
        'color_list': [str(color) for color in dendrogram['color_list']],
        'max_distance': float(max(max(row) for row in dendrogram['dcoord'])) if dendrogram['dcoord'] else 0.0
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    data = load_input(args.input)
    documents = data.get('documents', [])
    existing_embeddings = data.get('existing_embeddings', {})
    model_name = data.get('embedding_model', 'all-MiniLM-L6-v2')

    if not documents:
        write_output(args.output, {'error': 'no documents'})
        return

    new_docs = [d for d in documents if str(d['id']) not in existing_embeddings]
    new_texts = [d['text'][:2000] for d in new_docs]

    new_embeddings = {}
    if new_texts:
        print(f'[bertopic] generating embeddings for {len(new_texts)} new docs', file=sys.stderr)
        vectors = generate_embeddings(new_texts, model_name)
        for doc, vec in zip(new_docs, vectors):
            new_embeddings[str(doc['id'])] = vec

    all_embeddings = {**existing_embeddings, **new_embeddings}

    all_doc_ids = []
    all_embeddings_list = []
    all_texts = []
    all_dates = []

    for doc in documents:
        sid = str(doc['id'])
        if sid in all_embeddings:
            all_doc_ids.append(doc['id'])
            all_embeddings_list.append(all_embeddings[sid])
            all_texts.append(doc['text'][:2000])
            all_dates.append(doc.get('date_created'))

    print(f'[bertopic] running on {len(all_doc_ids)} documents', file=sys.stderr)
    result = run_bertopic(all_doc_ids, all_embeddings_list, all_texts, all_dates)

    if result is None:
        write_output(args.output, {
            'new_embeddings': new_embeddings,
            'topics': [],
            'assignments': [],
            'hierarchy': [],
            'hierarchy_plot': None,
            'evolution': [],
            'skipped': True,
            'reason': 'too few documents'
        })
        return

    write_output(args.output, {
        'new_embeddings': new_embeddings,
        'topics': result['topics'],
        'assignments': result['assignments'],
        'hierarchy': result['hierarchy'],
        'hierarchy_plot': result['hierarchy_plot'],
        'evolution': result['evolution']
    })
    print(f'[bertopic] done. {len(result["topics"])} topics found.', file=sys.stderr)


if __name__ == '__main__':
    main()
